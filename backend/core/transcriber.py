"""ステップ2：文字起こし。

無音カット後の動画（cut.mp4）の音声を faster-whisper で文字起こしし、transcript.json に保存する。
仕様は docs/03_transcription.md を参照。
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable

import numpy as np

from .errors import CancelledByUser, EngineError
from .media import extract_audio, probe, read_wav

logger = logging.getLogger(__name__)

CUT_FILE = "cut.mp4"
AUDIO_FILE = "cut_audio.wav"
RESULT_FILE = "transcript.json"

DEFAULT_MODEL = "large-v3"
DEFAULT_LANGUAGE = "ja"

# 書き出し時の start < end のチェックに引っかからないよう、表示時間をこれより短くしない
MIN_SEGMENT_SEC = 0.2

# 進捗（0〜100）のうち、各工程が占める範囲
_PROGRESS_EXTRACT = (0.0, 5.0)
_PROGRESS_TRANSCRIBE = (5.0, 100.0)
_LOG_STEP_PERCENT = 10

# これらの語を含むエラーは、CUDA の DLL が見つからないなど GPU 側の問題とみなす
_CUDA_ERROR_HINTS = ("cuda", "cublas", "cudnn")

ProgressCallback = Callable[[float], None]


@dataclass(frozen=True)
class TranscriptSegment:
    id: str
    index: int
    start: float
    end: float
    text: str
    confidence: float

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        for key in ("start", "end", "confidence"):
            data[key] = round(data[key], 3)
        return data


@dataclass(frozen=True)
class RawSegment:
    """faster-whisper が返した区切りのうち、使う項目だけを取り出したもの。"""

    start: float
    end: float
    text: str
    avg_logprob: float


def build_segments(raw: list[RawSegment], duration: float) -> list[TranscriptSegment]:
    """Whisper の区切りを、テロップとして使える形に整える（docs/03_transcription.md「4. 結果の整え方」）。"""
    segments: list[TranscriptSegment] = []
    prev_end = 0.0
    for r in raw:
        text = r.text.strip()
        if not text:
            continue
        start = max(r.start, prev_end, 0.0)
        if start >= duration:
            continue
        end = min(max(r.end, start + MIN_SEGMENT_SEC), duration)
        confidence = min(max(math.exp(r.avg_logprob), 0.0), 1.0)
        index = len(segments)
        segments.append(TranscriptSegment(f"seg_{index + 1:04d}", index, start, end, text, confidence))
        prev_end = end
    return segments


def _is_cuda_error(error: BaseException) -> bool:
    message = str(error).lower()
    return any(hint in message for hint in _CUDA_ERROR_HINTS)


class Transcriber:
    """faster-whisper のモデルを持ち、文字起こしを行う。

    モデルの読み込みには時間がかかるので、1つのインスタンスを使い回す（API サーバーでは1つだけ作る）。
    """

    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        language: str = DEFAULT_LANGUAGE,
        device: str = "auto",
        compute_type: str = "auto",
        download_root: str | Path | None = None,
    ) -> None:
        if device not in ("auto", "cuda", "cpu"):
            raise ValueError("device は auto / cuda / cpu のどれかで指定してください。")
        self.model_name = model
        self.language = language
        self.device_setting = device
        self.compute_type_setting = compute_type
        self.download_root = str(download_root) if download_root else None
        self._model: Any = None
        self._device: str | None = None

    @property
    def device(self) -> str | None:
        """実際に使っているデバイス（モデルを読み込む前は None）。"""
        return self._device

    # ---------- モデル ----------

    def resolve_device(self) -> str:
        """モデルを読み込まずに、使う予定のデバイス（cuda / cpu）を判定する。GET /health でも使う。"""
        if self.device_setting != "auto":
            return self.device_setting
        try:
            import ctranslate2

            return "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:
            return "cpu"

    def _load_model(self) -> Any:
        if self._model is not None:
            return self._model
        try:
            from faster_whisper import WhisperModel
        except ImportError as e:
            raise EngineError(
                "INTERNAL_ERROR",
                "faster-whisper が見つかりません。backend/requirements.txt のライブラリをインストールしてください。",
            ) from e

        device = self._device or self.resolve_device()
        compute_type = self.compute_type_setting
        if compute_type == "auto":
            compute_type = "float16" if device == "cuda" else "int8"

        logger.info(
            "モデル %s を読み込みます（device=%s, compute_type=%s）。初回はダウンロードに時間がかかります。",
            self.model_name, device, compute_type,
        )
        started = time.monotonic()
        self._model = WhisperModel(
            self.model_name,
            device=device,
            compute_type=compute_type,
            download_root=self.download_root,
        )
        self._device = device
        logger.info("モデルを読み込みました（%.1f 秒）。", time.monotonic() - started)
        return self._model

    # ---------- 文字起こし ----------

    def _run(
        self,
        audio: np.ndarray,
        duration: float,
        on_progress: ProgressCallback | None,
        cancel_event: threading.Event | None,
    ) -> list[RawSegment]:
        model = self._load_model()
        segments_iter, _info = model.transcribe(
            audio,
            language=self.language,
            beam_size=5,
            condition_on_previous_text=False,
            vad_filter=False,
        )

        start, end = _PROGRESS_TRANSCRIBE
        raw: list[RawSegment] = []
        next_log = _LOG_STEP_PERCENT
        # segments_iter は1文ずつ文字起こししながら返すジェネレーターなので、ここで進捗と中断を扱える
        for seg in segments_iter:
            if cancel_event is not None and cancel_event.is_set():
                raise CancelledByUser()
            raw.append(RawSegment(seg.start, seg.end, seg.text, seg.avg_logprob))

            percent = min(seg.end / duration, 1.0) * 100 if duration > 0 else 100.0
            if on_progress:
                on_progress(start + (end - start) * percent / 100)
            if percent >= next_log:
                logger.info("文字起こし中… %d%%（%d 文）", int(percent), len(raw))
                next_log = (int(percent) // _LOG_STEP_PERCENT + 1) * _LOG_STEP_PERCENT
        return raw

    def _run_with_fallback(
        self,
        audio: np.ndarray,
        duration: float,
        on_progress: ProgressCallback | None,
        cancel_event: threading.Event | None,
    ) -> list[RawSegment]:
        try:
            return self._run(audio, duration, on_progress, cancel_event)
        except (CancelledByUser, EngineError):
            raise
        except Exception as e:
            # CUDA の DLL の不足などは、モデルの読み込み時ではなく最初の文字起こしで発覚することが多い
            gpu_failed = self.device_setting == "auto" and self._device in (None, "cuda") and _is_cuda_error(e)
            if not gpu_failed:
                raise
            logger.warning("GPU（CUDA）で実行できなかったため、CPU で最初からやり直します：%s", e)
            self._model = None
            self._device = "cpu"
            return self._run(audio, duration, on_progress, cancel_event)

    def transcribe(
        self,
        work_dir: str | Path,
        *,
        on_progress: ProgressCallback | None = None,
        cancel_event: threading.Event | None = None,
    ) -> list[TranscriptSegment]:
        """work_dir の cut.mp4 を文字起こしし、transcript.json を保存して結果を返す。

        on_progress には進捗（0〜100）を渡す。cancel_event がセットされると CancelledByUser を送出する。
        """
        work = Path(work_dir)
        cut_path = work / CUT_FILE
        if not cut_path.is_file():
            raise EngineError(
                "FILE_NOT_FOUND",
                "無音カット後の動画（cut.mp4）が見つかりません。先にステップ1を実行してください。",
                {"path": str(cut_path)},
            )

        started = time.monotonic()
        duration = probe(cut_path).duration
        logger.info("文字起こしを開始します：%s（%.1f 秒）", cut_path, duration)

        audio_path = work / AUDIO_FILE
        extract_start, extract_end = _PROGRESS_EXTRACT
        extract_audio(
            cut_path,
            audio_path,
            duration=duration,
            on_progress=(lambda r: on_progress(extract_start + (extract_end - extract_start) * r)) if on_progress else None,
            cancel_event=cancel_event,
        )
        audio = read_wav(audio_path)

        try:
            raw = self._run_with_fallback(audio, duration, on_progress, cancel_event)
        except (CancelledByUser, EngineError):
            raise
        except Exception as e:
            raise EngineError(
                "TRANSCRIPTION_ERROR",
                "文字起こしに失敗しました。",
                {"model": self.model_name, "device": self._device, "reason": str(e)},
            ) from e

        segments = build_segments(raw, duration)
        self._save(work, duration, segments)
        if on_progress:
            on_progress(100.0)
        logger.info("文字起こしが完了しました：%d 文（%.1f 秒）", len(segments), time.monotonic() - started)
        return segments

    def _save(self, work_dir: Path, duration: float, segments: list[TranscriptSegment]) -> None:
        data = {
            "model": self.model_name,
            "language": self.language,
            "device": self._device,
            "duration": round(duration, 3),
            "segments": [s.to_dict() for s in segments],
        }
        (work_dir / RESULT_FILE).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _format_time(seconds: float) -> str:
    m, s = divmod(seconds, 60)
    return f"{int(m):02d}:{s:06.3f}"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="文字起こしだけを単体で実行する（ステップ1を実行済みのフォルダが必要）")
    parser.add_argument("work_dir", help="cut.mp4 があるフォルダ（例：../temp/test）")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="faster-whisper のモデル名（small / medium / large-v3 など）")
    parser.add_argument("--language", default=DEFAULT_LANGUAGE, help="言語コード")
    parser.add_argument("--device", default="auto", choices=("auto", "cuda", "cpu"))
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    transcriber = Transcriber(model=args.model, language=args.language, device=args.device)
    try:
        result = transcriber.transcribe(args.work_dir)
    except EngineError as e:
        print(json.dumps(e.to_dict(), ensure_ascii=False, indent=2))
        raise SystemExit(1) from e

    for seg in result:
        warning = "  ※要確認" if seg.confidence < 0.8 else ""
        print(f"[{_format_time(seg.start)} → {_format_time(seg.end)}] {seg.text}（信頼度 {seg.confidence:.2f}）{warning}")
    print(f"\n{len(result)} 文を {Path(args.work_dir) / RESULT_FILE} に保存しました（device={transcriber.device}）。")
