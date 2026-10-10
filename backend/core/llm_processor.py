"""ステップ3：LLM による重要度判定と3択生成。

transcript.json の各文を Ollama に渡して重要度（1〜3）と要約版・インパクト重視版を作り、
UI に渡す最終データ result.json を保存する。仕様は docs/04_llm_processing.md を参照。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, Callable

import httpx
from pydantic import BaseModel, Field, StringConstraints, ValidationError

from .errors import CancelledByUser, EngineError

logger = logging.getLogger(__name__)

TRANSCRIPT_FILE = "transcript.json"
SILENCE_CUT_FILE = "silence_cut.json"
RESULT_FILE = "result.json"

DEFAULT_MODEL = "qwen2.5:7b"
# Windows では localhost が先に IPv6（::1）で接続を試みて待たされることがあるので、IPv4 を直接指定する
DEFAULT_URL = os.environ.get("EDITAI_OLLAMA_URL", "http://127.0.0.1:11434")
DEFAULT_BATCH_SIZE = 20
DEFAULT_CONTEXT_SIZE = 3
DEFAULT_TIMEOUT = 300.0

# 既定値（フォールバック）の重要度
FALLBACK_IMPORTANCE = 2

ProgressCallback = Callable[[float], None]

SYSTEM_PROMPT = """\
あなたは日本語の動画編集アシスタントです。動画の文字起こしを読み、テロップ（字幕）用に各文を評価して書き換えます。

# 入力
- 「文脈（前）」「文脈（後）」：話の流れを理解するための前後の文です。評価はしません。
- 「対象」：評価する文です。各行は「ID: 本文」の形です。

# 対象の文ごとに出力する項目
1. importance（重要度）：1〜3 の整数
   - 3：話の要点・結論・新しい情報・驚きや笑いなど、視聴者に必ず見せたい文
   - 2：説明や補足など、内容のある普通の文
   - 1：相づち（「はい」「うん」）、言い直し、「えーと」などのつなぎ、あいさつだけの文など、内容がほとんどない文
2. summary（要約）：意味を変えずに、読みやすく短く整えた文
   - 「えー」「あのー」「まあ」などのつなぎの言葉と言い直しを取り除く
   - 必要なら句読点を付ける
   - 原文より長くしない
3. impact（インパクト重視）：視聴者の目を引く短いテロップ
   - 15 文字程度まで。体言止めや「！」を使ってよい
   - 原文にない事実や数値を足さない

# ルール
- 「対象」のすべての文について、同じ ID で1件ずつ、入力と同じ順番で返してください。
- 固有名詞や数値は原文のまま使ってください。
- 内容のない文は、summary と impact を原文と同じか、ごく短くしてかまいません。
- JSON だけを出力し、説明は書かないでください。

# 例
入力：
## 対象
seg_0001: えーと今日はですね新しいカメラを紹介していきたいと思います
seg_0002: まあ、はい

出力：
{"results": [
  {"id": "seg_0001", "importance": 3, "summary": "今日は新しいカメラを紹介します", "impact": "新カメラ、ついに解禁！"},
  {"id": "seg_0002", "importance": 1, "summary": "はい", "impact": "はい"}
]}
"""

RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "importance": {"type": "integer", "enum": [1, 2, 3]},
                    "summary": {"type": "string"},
                    "impact": {"type": "string"},
                },
                "required": ["id", "importance", "summary", "impact"],
            },
        }
    },
    "required": ["results"],
}

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class LLMItem(BaseModel):
    """LLM が返す1文ぶんの結果（docs/01_api_schema.md「5. LLM の出力形式」）。"""

    id: str
    importance: int = Field(ge=1, le=3)
    summary: NonEmptyText
    impact: NonEmptyText


@dataclass
class AnalyzedSegment:
    """API の Segment（docs/01_api_schema.md 3.1）。"""

    id: str
    index: int
    start: float
    end: float
    original: str
    confidence: float
    importance: int = FALLBACK_IMPORTANCE
    summary: str = ""
    impact: str = ""
    llm_ok: bool = False

    def __post_init__(self) -> None:
        self.summary = self.summary or self.original
        self.impact = self.impact or self.original

    def apply(self, item: LLMItem) -> None:
        self.importance = item.importance
        self.summary = item.summary
        self.impact = item.impact
        self.llm_ok = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "index": self.index,
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "importance": self.importance,
            "variants": {"original": self.original, "summary": self.summary, "impact": self.impact},
            "confidence": round(self.confidence, 3),
        }


@dataclass
class LLMReport:
    """result.json の llm 欄。"""

    status: str
    model: str
    failed_segments: int = 0
    message: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "model": self.model,
            "failed_segments": self.failed_segments,
            "message": self.message,
        }


class _OllamaUnavailable(Exception):
    """Ollama に接続できない、またはモデルがない。残りの文はすべて既定値にする。"""


class _BatchFailed(Exception):
    """1回の問い合わせが失敗した（JSON が読めない、時間切れなど）。送り直せば直る可能性がある。"""


@dataclass
class _Batch:
    targets: list[AnalyzedSegment]
    before: list[AnalyzedSegment] = field(default_factory=list)
    after: list[AnalyzedSegment] = field(default_factory=list)


def build_user_message(targets: list[AnalyzedSegment], before: list[AnalyzedSegment], after: list[AnalyzedSegment]) -> str:
    """docs/04_llm_processing.md「4.3 ユーザーメッセージ」の形を作る。"""
    sections: list[str] = []
    if before:
        sections.append("## 文脈（前）\n" + "\n".join(f"{s.id}: {s.original}" for s in before))
    sections.append("## 対象\n" + "\n".join(f"{s.id}: {s.original}" for s in targets))
    if after:
        sections.append("## 文脈（後）\n" + "\n".join(f"{s.id}: {s.original}" for s in after))
    return "\n\n".join(sections)


def parse_response(content: str, target_ids: set[str]) -> dict[str, LLMItem]:
    """LLM の出力を検証し、対象の ID ごとの結果にする。不正な要素は1件ずつ捨てる。"""
    try:
        data = json.loads(content)
    except json.JSONDecodeError as e:
        raise _BatchFailed(f"JSON として読めませんでした：{e}") from e
    raw_items = data.get("results") if isinstance(data, dict) else None
    if not isinstance(raw_items, list):
        raise _BatchFailed("results が配列ではありません。")

    items: dict[str, LLMItem] = {}
    for raw in raw_items:
        try:
            item = LLMItem.model_validate(raw)
        except ValidationError as e:
            logger.debug("不正な要素を捨てました：%s（%s）", raw, e.errors())
            continue
        if item.id in target_ids and item.id not in items:
            items[item.id] = item
    return items


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise EngineError("INTERNAL_ERROR", f"{path.name} を読み込めませんでした。", {"path": str(path), "reason": str(e)}) from e


def load_segments(work_dir: Path) -> list[AnalyzedSegment]:
    path = work_dir / TRANSCRIPT_FILE
    if not path.is_file():
        raise EngineError(
            "FILE_NOT_FOUND",
            "文字起こしの結果（transcript.json）が見つかりません。先にステップ2を実行してください。",
            {"path": str(path)},
        )
    data = _load_json(path)
    try:
        return [
            AnalyzedSegment(
                id=s["id"],
                index=s["index"],
                start=float(s["start"]),
                end=float(s["end"]),
                original=s["text"],
                confidence=float(s.get("confidence", 1.0)),
            )
            for s in data["segments"]
        ]
    except (KeyError, TypeError, ValueError) as e:
        raise EngineError("INTERNAL_ERROR", "transcript.json の形が正しくありません。", {"reason": repr(e)}) from e


def build_result(work_dir: Path, segments: list[AnalyzedSegment], report: LLMReport) -> dict[str, Any]:
    """GET /projects/{id}/result と同じ形（docs/01_api_schema.md 4.5）のデータを作る。"""
    source: dict[str, Any] | None = None
    silence_cut: dict[str, Any] | None = None
    silence_path = work_dir / SILENCE_CUT_FILE
    if silence_path.is_file():
        silence = _load_json(silence_path)
        media = silence.get("media", {})
        source = {
            "file_name": Path(silence.get("source_path", "")).name,
            "duration": round(media.get("duration", 0.0), 3),
            "width": media.get("width"),
            "height": media.get("height"),
            "fps": round(media.get("fps", 0.0), 3),
        }
        keys = ("enabled", "original_duration", "cut_duration", "removed_duration", "kept_ranges")
        silence_cut = {key: silence.get(key) for key in keys}

    project_id = work_dir.name
    summary = {str(level): sum(1 for s in segments if s.importance == level) for level in (1, 2, 3)}
    return {
        "project_id": project_id,
        "source": source,
        "silence_cut": silence_cut,
        "preview_url": f"/api/v1/projects/{project_id}/media/preview",
        "llm": report.to_dict(),
        "segments": [s.to_dict() for s in segments],
        "importance_summary": summary,
    }


class LLMProcessor:
    """Ollama を使って、各文の重要度と3択の文言を作る。"""

    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        base_url: str = DEFAULT_URL,
        *,
        enabled: bool = True,
        batch_size: int = DEFAULT_BATCH_SIZE,
        context_size: int = DEFAULT_CONTEXT_SIZE,
        timeout: float = DEFAULT_TIMEOUT,
        temperature: float = 0.3,
    ) -> None:
        if batch_size < 1 or context_size < 0:
            raise ValueError("batch_size は 1 以上、context_size は 0 以上で指定してください。")
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.enabled = enabled
        self.batch_size = batch_size
        self.context_size = context_size
        self.temperature = temperature
        self._timeout = httpx.Timeout(timeout, connect=5.0)

    # ---------- Ollama ----------

    def list_models(self) -> list[str]:
        """取得済みのモデル名の一覧。接続できなければ _OllamaUnavailable。GET /health でも使う想定。"""
        try:
            response = httpx.get(f"{self.base_url}/api/tags", timeout=httpx.Timeout(10.0, connect=5.0))
            response.raise_for_status()
            models = response.json().get("models", [])
        except (httpx.HTTPError, ValueError, AttributeError) as e:
            raise _OllamaUnavailable(f"Ollama に接続できません（{self.base_url}）。Ollama を起動してください。") from e
        return [m.get("name", "") for m in models]

    def _check_model(self) -> None:
        names = self.list_models()
        # タグを省略したモデル名は、Ollama では ":latest" 付きで登録される
        if self.model not in names and f"{self.model}:latest" not in names:
            raise _OllamaUnavailable(
                f"モデル {self.model} が見つかりません。`ollama pull {self.model}` を実行してください。"
            )

    def _request(self, client: httpx.Client, batch: _Batch, targets: list[AnalyzedSegment]) -> dict[str, LLMItem]:
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": build_user_message(targets, batch.before, batch.after)},
            ],
            "format": RESPONSE_SCHEMA,
            "stream": False,
            "options": {"temperature": self.temperature, "num_ctx": 8192},
            "keep_alive": "10m",
        }
        try:
            response = client.post("/api/chat", json=payload)
        except (httpx.ConnectError, httpx.ConnectTimeout) as e:
            raise _OllamaUnavailable(f"Ollama に接続できなくなりました（{self.base_url}）。") from e
        except httpx.TimeoutException as e:
            raise _BatchFailed("Ollama の応答が時間切れになりました。") from e
        except httpx.HTTPError as e:
            raise _BatchFailed(f"Ollama との通信に失敗しました：{e}") from e

        if response.status_code == 404:
            raise _OllamaUnavailable(f"モデル {self.model} が見つかりません。`ollama pull {self.model}` を実行してください。")
        if response.status_code != 200:
            raise _BatchFailed(f"Ollama がエラーを返しました（HTTP {response.status_code}）：{response.text[:500]}")

        try:
            content = response.json()["message"]["content"]
        except (ValueError, KeyError, TypeError) as e:
            raise _BatchFailed("Ollama の応答の形が想定と違います。") from e
        return parse_response(content, {s.id for s in targets})

    def _process_batch(self, client: httpx.Client, batch: _Batch) -> None:
        """バッチ内の文に結果を反映する。足りない文は1回だけ送り直す。"""
        pending = batch.targets
        for attempt in (1, 2):
            try:
                items = self._request(client, batch, pending)
            except _BatchFailed as e:
                logger.warning("問い合わせに失敗しました（%d 回目）：%s", attempt, e)
                items = {}
            for seg in pending:
                if seg.id in items:
                    seg.apply(items[seg.id])
            pending = [s for s in pending if not s.llm_ok]
            if not pending:
                return
            if attempt == 1:
                logger.warning("%d 文の結果が得られなかったため、その文だけ送り直します。", len(pending))
        logger.warning("%d 文は既定値（重要度 2・原文のまま）を使います：%s", len(pending), ", ".join(s.id for s in pending))

    def _batches(self, segments: list[AnalyzedSegment]) -> list[_Batch]:
        batches = []
        for i in range(0, len(segments), self.batch_size):
            end = i + self.batch_size
            batches.append(_Batch(
                targets=segments[i:end],
                before=segments[max(0, i - self.context_size):i],
                after=segments[end:end + self.context_size],
            ))
        return batches

    def _analyze(
        self,
        segments: list[AnalyzedSegment],
        on_progress: ProgressCallback | None,
        cancel_event: threading.Event | None,
    ) -> str | None:
        """全文を処理する。途中で Ollama が使えなくなったら、その理由を返す（残りは既定値のまま）。"""
        self._check_model()
        batches = self._batches(segments)
        logger.info("LLM 処理を開始します：%d 文・%d バッチ（モデル %s）", len(segments), len(batches), self.model)

        done = 0
        with httpx.Client(base_url=self.base_url, timeout=self._timeout) as client:
            for number, batch in enumerate(batches, start=1):
                if cancel_event is not None and cancel_event.is_set():
                    raise CancelledByUser()
                started = time.monotonic()
                try:
                    self._process_batch(client, batch)
                except _OllamaUnavailable as e:
                    return str(e)
                done += len(batch.targets)
                ok = sum(1 for s in batch.targets if s.llm_ok)
                logger.info(
                    "バッチ %d/%d：%d/%d 文成功（%.1f 秒）",
                    number, len(batches), ok, len(batch.targets), time.monotonic() - started,
                )
                if on_progress:
                    on_progress(done / len(segments) * 100)
        return None

    # ---------- 入口 ----------

    def process(
        self,
        work_dir: str | Path,
        *,
        on_progress: ProgressCallback | None = None,
        cancel_event: threading.Event | None = None,
    ) -> list[AnalyzedSegment]:
        """work_dir の transcript.json を処理し、result.json を保存して結果を返す。

        Ollama が使えない場合や想定外の出力の場合も止めず、該当する文を既定値にして続ける。
        on_progress には進捗（0〜100）を渡す。cancel_event がセットされると CancelledByUser を送出する。
        """
        work = Path(work_dir)
        segments = load_segments(work)
        message: str | None = None

        if not self.enabled:
            logger.info("LLM 処理は無効に設定されているため、全文を既定値にします。")
        elif segments:
            try:
                message = self._analyze(segments, on_progress, cancel_event)
            except _OllamaUnavailable as e:
                message = str(e)
            if message:
                logger.error("%s 残りの文は既定値（重要度 2・原文のまま）を使います。", message)

        report = self._report(segments, message)
        result = build_result(work, segments, report)
        (work / RESULT_FILE).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        if on_progress:
            on_progress(100.0)
        logger.info(
            "LLM 処理が完了しました：status=%s、既定値になった文 %d/%d、重要度の内訳 %s",
            report.status, report.failed_segments, len(segments), result["importance_summary"],
        )
        return segments

    def _report(self, segments: list[AnalyzedSegment], message: str | None) -> LLMReport:
        if not self.enabled:
            return LLMReport("disabled", self.model, len(segments))
        failed = sum(1 for s in segments if not s.llm_ok)
        if failed == 0:
            status = "ok"
        elif failed == len(segments):
            status = "failed"
        else:
            status = "partial"
        if status != "ok" and message is None:
            message = "一部の文で LLM の結果が得られなかったため、既定値を使いました。"
        return LLMReport(status, self.model, failed, message)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LLM 処理だけを単体で実行する（ステップ2を実行済みのフォルダが必要）")
    parser.add_argument("work_dir", help="transcript.json があるフォルダ（例：../temp/test）")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Ollama のモデル名")
    parser.add_argument("--url", default=DEFAULT_URL, help="Ollama の URL")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE, help="1回に評価させる文の数")
    parser.add_argument("--disable", action="store_true", help="LLM を使わず、全文を既定値にする")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    processor = LLMProcessor(model=args.model, base_url=args.url, enabled=not args.disable, batch_size=args.batch_size)
    try:
        result_segments = processor.process(args.work_dir)
    except EngineError as e:
        print(json.dumps(e.to_dict(), ensure_ascii=False, indent=2))
        raise SystemExit(1) from e

    for seg in result_segments:
        mark = "" if seg.llm_ok else "  ※既定値"
        print(f"\n[{seg.id}] 重要度 {seg.importance}{mark}")
        print(f"  原文      ：{seg.original}")
        print(f"  要約      ：{seg.summary}")
        print(f"  インパクト：{seg.impact}")

    saved = json.loads((Path(args.work_dir) / RESULT_FILE).read_text(encoding="utf-8"))
    print(f"\nllm: {json.dumps(saved['llm'], ensure_ascii=False)}")
    print(f"重要度の内訳: {saved['importance_summary']}")
    print(f"{Path(args.work_dir) / RESULT_FILE} に保存しました。")
