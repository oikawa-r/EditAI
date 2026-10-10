"""解析（ステップ1〜3）と書き出し（ステップ5）のジョブ管理。

重い処理は ThreadPoolExecutor で1件ずつ実行し、状態はメモリと JSON ファイル（status.json、exports/{id}.json）の
両方で持つ。受け取った書き出しリクエストは exports/{id}.request.json に残す。
サーバーを再起動しても、ファイルから状態を戻せる。
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

from core.errors import CancelledByUser, EngineError
from core.llm_processor import LLMProcessor, LLMReport, build_result
from core.silence_cutter import SilenceOptions, cut_silence, stage_without_cut
from core.sub_exporter import SubExporter, validate_segments
from core.transcriber import Transcriber

from .schemas import ExportRequest, ProjectOptions, TranscriptionOptionsIn

logger = logging.getLogger(__name__)

STATUS_FILE = "status.json"
CUT_FILE = "cut.mp4"
RESULT_FILE = "result.json"
EXPORTS_DIR = "exports"

TERMINAL = frozenset({"completed", "failed", "cancelled"})

# 解析の3工程と、全体の進捗に占める重み（docs/01_api_schema.md 4.3）
ANALYSIS_STEPS = (
    ("silence_cutting", "無音カット中", 20.0),
    ("transcribing", "文字起こし中", 40.0),
    ("llm_processing", "AI で重要度を判定中", 40.0),
)
_STEP_LABELS = {name: label for name, label, _ in ANALYSIS_STEPS}

# 進捗は頻繁に更新されるので、ファイルへの保存はこの間隔（秒）より短くしない（状態が変わったときは必ず保存する）
_SAVE_INTERVAL = 1.0

def _write_silence_only_result(work_dir: Path, model: str) -> None:
    """文字起こしをしない解析の result.json。無音区間だけを残す。"""
    report = LLMReport("disabled", model, 0, "文字起こしを行っていないため、テロップはありません。")
    result = build_result(work_dir, [], report)
    _write_json(work_dir / RESULT_FILE, result)


_INTERRUPTED_ERROR = {
    "code": "INTERNAL_ERROR",
    "message": "サーバーが停止したため中断されました。",
    "details": {},
}


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _write_json(path: Path, data: dict[str, Any]) -> None:
    # 書き込み中にサーバーが止まっても壊れたファイルが残らないよう、別名で書いてから置き換える
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as e:
        # Windows ではウイルス対策ソフトなどが一瞬ファイルを開いていて置き換えに失敗することがある。
        # 状態の保存は再起動に備えたものなので、失敗しても処理は止めない（メモリ上の状態は正しい）
        logger.warning("状態ファイルを保存できませんでした：%s（%s）", path, e)


def _eta(started: float | None, progress: float) -> int | None:
    """ここまでの速さから残り時間（秒）を見積もる。"""
    if started is None or progress < 1.0:
        return None
    if progress >= 100.0:
        return 0
    elapsed = time.monotonic() - started
    return round(elapsed * (100.0 - progress) / progress)


def _internal_error(e: BaseException) -> dict[str, Any]:
    return {"code": "INTERNAL_ERROR", "message": "想定外のエラーが発生しました。", "details": {"reason": repr(e)}}


class ProjectJob:
    """1つの動画の解析（ステップ1〜3）の状態。一度終わった（completed / failed / cancelled）状態は変えない。"""

    def __init__(
        self,
        project_id: str,
        work_dir: Path,
        source_path: Path,
        options: ProjectOptions,
        created_at: str | None = None,
    ) -> None:
        self.id = project_id
        self.dir = work_dir
        self.source_path = source_path
        self.options = options
        self.created_at = created_at or now_iso()
        self.updated_at = self.created_at
        self.status = "queued"
        self.steps = {name: {"status": "pending", "progress": 0.0} for name, _, _ in ANALYSIS_STEPS}
        self.error: dict[str, Any] | None = None
        self.cancel_event = threading.Event()
        self._lock = threading.Lock()
        self._started: float | None = None
        self._last_save = 0.0

    # ---------- 状態の取得 ----------

    def _progress(self) -> float:
        total = sum(weight * self.steps[name]["progress"] / 100 for name, _, weight in ANALYSIS_STEPS)
        return round(total, 1)

    def _status_dict(self) -> dict[str, Any]:
        running = self.status in _STEP_LABELS
        progress = self._progress()
        current = None
        if running:
            current = {
                "name": self.status,
                "label": _STEP_LABELS[self.status],
                "progress": round(self.steps[self.status]["progress"], 1),
            }
        return {
            "project_id": self.id,
            "status": self.status,
            "progress": progress,
            "current_step": current,
            "steps": [
                {"name": name, "status": self.steps[name]["status"], "progress": round(self.steps[name]["progress"], 1)}
                for name, _, _ in ANALYSIS_STEPS
            ],
            "eta_seconds": _eta(self._started, progress) if running else None,
            "error": self.error,
            "updated_at": self.updated_at,
        }

    def status_response(self) -> dict[str, Any]:
        """GET /projects/{id}/status のレスポンス。"""
        with self._lock:
            return self._status_dict()

    # ---------- 状態の変更（_touch はロックを取った状態で呼ぶ） ----------

    def _touch(self, force_save: bool = False) -> None:
        self.updated_at = now_iso()
        now = time.monotonic()
        if force_save or now - self._last_save >= _SAVE_INTERVAL:
            self._last_save = now
            data = {
                **self._status_dict(),
                "source_path": str(self.source_path),
                "options": self.options.model_dump(),
                "created_at": self.created_at,
            }
            _write_json(self.dir / STATUS_FILE, data)

    def save(self) -> None:
        with self._lock:
            self._touch(force_save=True)

    def begin(self) -> None:
        with self._lock:
            self._started = time.monotonic()

    def start_step(self, name: str) -> None:
        with self._lock:
            if self.status in TERMINAL:
                return
            self.status = name
            self.steps[name] = {"status": "running", "progress": 0.0}
            self._touch(force_save=True)

    def set_progress(self, name: str, progress: float) -> None:
        with self._lock:
            if self.status in TERMINAL:
                return
            self.steps[name]["progress"] = min(max(progress, 0.0), 100.0)
            self._touch()

    def finish_step(self, name: str) -> None:
        with self._lock:
            if self.status in TERMINAL:
                return
            self.steps[name] = {"status": "completed", "progress": 100.0}
            self._touch(force_save=True)

    def skip_step(self, name: str) -> None:
        with self._lock:
            if self.status in TERMINAL:
                return
            self.steps[name] = {"status": "skipped", "progress": 100.0}
            self._touch(force_save=True)

    def complete(self) -> None:
        with self._lock:
            if self.status in TERMINAL:
                return
            self.status = "completed"
            self._touch(force_save=True)

    def _stop_running_steps(self, step_status: str) -> None:
        for step in self.steps.values():
            if step["status"] == "running":
                step["status"] = step_status

    def fail(self, error: dict[str, Any]) -> None:
        with self._lock:
            if self.status in TERMINAL:
                return
            self.status = "failed"
            self.error = error
            self._stop_running_steps("failed")
            self._touch(force_save=True)

    def cancel(self) -> bool:
        """中断する。すでに終わっていたら False。"""
        with self._lock:
            if self.status in TERMINAL:
                return False
            self.cancel_event.set()
            self.status = "cancelled"
            self._stop_running_steps("cancelled")
            self._touch(force_save=True)
            return True

    @classmethod
    def load(cls, path: Path) -> ProjectJob:
        """status.json から状態を戻す。途中だった解析は、サーバーの停止で中断されたものとして failed にする。"""
        data = json.loads(path.read_text(encoding="utf-8"))
        job = cls(
            data["project_id"],
            path.parent,
            Path(data["source_path"]),
            ProjectOptions.model_validate(data.get("options") or {}),
            data.get("created_at"),
        )
        job.status = data["status"]
        job.error = data.get("error")
        job.updated_at = data.get("updated_at", job.created_at)
        for step in data.get("steps", []):
            if step.get("name") in job.steps:
                job.steps[step["name"]] = {"status": step["status"], "progress": float(step["progress"])}
        if job.status not in TERMINAL:
            job.fail(dict(_INTERRUPTED_ERROR))
        return job


class ExportJob:
    """1回の書き出し（ステップ5）の状態。"""

    def __init__(self, export_id: str, project_id: str, export_dir: Path, created_at: str | None = None) -> None:
        self.id = export_id
        self.project_id = project_id
        self.dir = export_dir
        self.created_at = created_at or now_iso()
        self.status = "queued"
        self.progress = 0.0
        self.output_path: str | None = None
        self.ass_path: str | None = None
        self.error: dict[str, Any] | None = None
        self.cancel_event = threading.Event()
        self._lock = threading.Lock()
        self._started: float | None = None
        self._last_save = 0.0

    def _status_dict(self) -> dict[str, Any]:
        progress = round(self.progress, 1)
        return {
            "export_id": self.id,
            "status": self.status,
            "progress": progress,
            "eta_seconds": _eta(self._started, progress) if self.status not in TERMINAL else None,
            "output_path": self.output_path,
            "ass_path": self.ass_path,
            "error": self.error,
        }

    def status_response(self) -> dict[str, Any]:
        """GET /projects/{id}/exports/{export_id} のレスポンス。"""
        with self._lock:
            return self._status_dict()

    def _touch(self, force_save: bool = False) -> None:
        now = time.monotonic()
        if force_save or now - self._last_save >= _SAVE_INTERVAL:
            self._last_save = now
            data = {**self._status_dict(), "project_id": self.project_id, "created_at": self.created_at}
            _write_json(self.dir / f"{self.id}.json", data)

    def save(self) -> None:
        with self._lock:
            self._touch(force_save=True)

    def begin(self) -> None:
        with self._lock:
            self._started = time.monotonic()

    def set_progress(self, progress: float, status: str) -> None:
        with self._lock:
            if self.status in TERMINAL:
                return
            changed = status != self.status
            self.status = status
            self.progress = min(max(progress, 0.0), 100.0)
            if self.ass_path is None:
                self.ass_path = str(self.dir / f"{self.id}.ass")
            self._touch(force_save=changed)

    def complete(self, output_path: Path, ass_path: Path) -> None:
        with self._lock:
            if self.status in TERMINAL:
                return
            self.status = "completed"
            self.progress = 100.0
            self.output_path = str(output_path)
            self.ass_path = str(ass_path)
            self._touch(force_save=True)

    def fail(self, error: dict[str, Any]) -> None:
        with self._lock:
            if self.status in TERMINAL:
                return
            self.status = "failed"
            self.error = error
            self._touch(force_save=True)

    @classmethod
    def load(cls, path: Path) -> ExportJob:
        data = json.loads(path.read_text(encoding="utf-8"))
        job = cls(data["export_id"], data["project_id"], path.parent, data.get("created_at"))
        job.status = data["status"]
        job.progress = float(data.get("progress", 0.0))
        job.output_path = data.get("output_path")
        job.ass_path = data.get("ass_path")
        job.error = data.get("error")
        if job.status not in TERMINAL:
            job.fail(dict(_INTERRUPTED_ERROR))
        return job


class JobManager:
    """プロジェクトと書き出しのジョブを管理する。解析と書き出しは、それぞれ1件ずつ順番に実行する。"""

    def __init__(self, temp_dir: Path) -> None:
        self.temp_dir = temp_dir
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self._projects: dict[str, ProjectJob] = {}
        self._exports: dict[str, ExportJob] = {}
        self._lock = threading.Lock()
        # GPU メモリの不足を防ぐため、解析と書き出しはそれぞれ1件ずつ（2件目以降は queued で待つ）
        self._analysis_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="analysis")
        self._export_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="export")
        # Whisper のモデルは読み込みに時間がかかるので、同じ設定なら使い回す（解析スレッドだけが使う）
        self._transcriber: Transcriber | None = None
        self._restore()

    # ---------- 起動時の復元・終了 ----------

    def _restore(self) -> None:
        for status_path in self.temp_dir.glob(f"*/{STATUS_FILE}"):
            try:
                project = ProjectJob.load(status_path)
            except (OSError, ValueError, KeyError, TypeError) as e:
                logger.warning("プロジェクトの状態を読み込めませんでした：%s（%s）", status_path, e)
                continue
            self._projects[project.id] = project
            for export_path in (project.dir / EXPORTS_DIR).glob("*.json"):
                # リクエスト本体は状態ファイルではない
                if export_path.name.endswith(".request.json"):
                    continue
                try:
                    export = ExportJob.load(export_path)
                except (OSError, ValueError, KeyError, TypeError) as e:
                    logger.warning("書き出しの状態を読み込めませんでした：%s（%s）", export_path, e)
                    continue
                self._exports[export.id] = export
        logger.info("プロジェクト %d 件、書き出し %d 件の状態を読み込みました。", len(self._projects), len(self._exports))

    def shutdown(self) -> None:
        with self._lock:
            jobs = [*self._projects.values(), *self._exports.values()]
        # 実行中の FFmpeg などを止める。status は、ジョブ側で「サーバーの停止で中断」の failed になる
        for job in jobs:
            job.cancel_event.set()
        self._analysis_pool.shutdown(wait=False, cancel_futures=True)
        self._export_pool.shutdown(wait=False, cancel_futures=True)

    # ---------- プロジェクト（解析） ----------

    def new_project_dir(self) -> tuple[str, Path]:
        project_id = str(uuid.uuid4())
        work_dir = self.temp_dir / project_id
        work_dir.mkdir(parents=True)
        return project_id, work_dir

    def discard_project_dir(self, work_dir: Path) -> None:
        shutil.rmtree(work_dir, ignore_errors=True)

    def submit_project(self, project_id: str, work_dir: Path, source_path: Path, options: ProjectOptions) -> ProjectJob:
        job = ProjectJob(project_id, work_dir, source_path, options)
        job.save()
        with self._lock:
            self._projects[project_id] = job
        self._analysis_pool.submit(self._run_analysis, job)
        logger.info("解析を受け付けました：%s（%s）", project_id, source_path)
        return job

    def get_project(self, project_id: str) -> ProjectJob:
        with self._lock:
            job = self._projects.get(project_id)
        if job is None:
            raise EngineError("PROJECT_NOT_FOUND", "指定されたプロジェクトが見つかりません。", {"project_id": project_id})
        return job

    def cancel_project(self, project_id: str) -> ProjectJob:
        job = self.get_project(project_id)
        if not job.cancel():
            raise EngineError(
                "NOT_READY",
                "解析はすでに終わっているため、中断できません。",
                {"project_id": project_id, "status": job.status},
            )
        logger.info("解析を中断しました：%s", project_id)
        return job

    def _get_transcriber(self, options: TranscriptionOptionsIn) -> Transcriber:
        current = self._transcriber
        if current is None or current.model_name != options.model or current.language != options.language:
            self._transcriber = Transcriber(model=options.model, language=options.language)
        return self._transcriber

    def _run_analysis(self, job: ProjectJob) -> None:
        if job.cancel_event.is_set():
            return
        job.begin()
        options = job.options
        started = time.monotonic()
        try:
            run_silence = options.silence.enabled
            run_text = options.transcription.enabled
            run_llm = options.llm.enabled and run_text
            if run_silence:
                job.start_step("silence_cutting")
                cut_silence(
                    job.source_path,
                    job.dir,
                    SilenceOptions(**options.silence.model_dump()),
                    on_progress=lambda p: job.set_progress("silence_cutting", p),
                    cancel_event=job.cancel_event,
                )
                job.finish_step("silence_cutting")
            else:
                if run_text:
                    stage_without_cut(job.source_path, job.dir)
                job.skip_step("silence_cutting")

            if run_text:
                job.start_step("transcribing")
                self._get_transcriber(options.transcription).transcribe(
                    job.dir,
                    on_progress=lambda p: job.set_progress("transcribing", p),
                    cancel_event=job.cancel_event,
                )
                job.finish_step("transcribing")
            else:
                job.skip_step("transcribing")

            if run_llm:
                job.start_step("llm_processing")
                LLMProcessor(model=options.llm.model, enabled=True).process(
                    job.dir,
                    on_progress=lambda p: job.set_progress("llm_processing", p),
                    cancel_event=job.cancel_event,
                )
                job.finish_step("llm_processing")
            elif run_text:
                job.start_step("llm_processing")
                LLMProcessor(model=options.llm.model, enabled=False).process(
                    job.dir,
                    on_progress=lambda p: job.set_progress("llm_processing", p),
                    cancel_event=job.cancel_event,
                )
                job.finish_step("llm_processing")
            else:
                _write_silence_only_result(job.dir, options.llm.model)
                job.skip_step("llm_processing")

            job.complete()
            logger.info("解析が完了しました：%s（%.1f 秒）", job.id, time.monotonic() - started)
        except CancelledByUser:
            # ユーザーの中断なら status はすでに cancelled。そうでなければサーバーの停止による中断
            job.fail(dict(_INTERRUPTED_ERROR))
        except EngineError as e:
            logger.error("解析に失敗しました：%s（%s：%s）", job.id, e.code, e.message)
            job.fail(e.to_dict())
        except Exception as e:
            logger.exception("解析中に想定外のエラーが発生しました：%s", job.id)
            job.fail(_internal_error(e))

    # ---------- 書き出し ----------

    def submit_export(self, project: ProjectJob, request: ExportRequest) -> ExportJob:
        if project.status != "completed":
            raise EngineError(
                "NOT_READY",
                "解析が終わっていないため、書き出しできません。",
                {"project_id": project.id, "status": project.status},
            )
        validate_segments(request.segments)

        export_id = str(uuid.uuid4())
        export_dir = project.dir / EXPORTS_DIR
        output_path = Path(request.output.path).resolve() if request.output.path else export_dir / f"{export_id}.mp4"
        if output_path.exists() and not request.output.overwrite:
            raise EngineError("OUTPUT_EXISTS", "書き出し先に同じ名前のファイルがあります。", {"path": str(output_path)})

        with self._lock:
            running = [
                e.id for e in self._exports.values()
                if e.project_id == project.id and e.status not in TERMINAL
            ]
            if running:
                raise EngineError(
                    "ALREADY_RUNNING",
                    "このプロジェクトはすでに書き出し中です。",
                    {"project_id": project.id, "export_id": running[0]},
                )
            export_dir.mkdir(parents=True, exist_ok=True)
            # 検証済みのタイムラインを残し、同じオブジェクトを書き出しジョブへ渡す
            _write_json(export_dir / f"{export_id}.request.json", request.model_dump(mode="json"))
            job = ExportJob(export_id, project.id, export_dir)
            job.save()
            self._exports[export_id] = job

        self._export_pool.submit(self._run_export, job, project, request)
        logger.info("書き出しを受け付けました：%s（プロジェクト %s）", export_id, project.id)
        return job

    def get_export(self, project_id: str, export_id: str) -> ExportJob:
        self.get_project(project_id)
        with self._lock:
            job = self._exports.get(export_id)
        if job is None or job.project_id != project_id:
            raise EngineError(
                "EXPORT_NOT_FOUND",
                "指定された書き出しが見つかりません。",
                {"project_id": project_id, "export_id": export_id},
            )
        return job

    def _run_export(self, job: ExportJob, project: ProjectJob, request: ExportRequest) -> None:
        if job.cancel_event.is_set():
            return
        job.begin()
        try:
            result = SubExporter().export_timeline(
                request,
                export_dir=job.dir,
                export_id=job.id,
                on_progress=job.set_progress,
                cancel_event=job.cancel_event,
            )
            job.complete(result.output_path, result.ass_path)
        except CancelledByUser:
            job.fail(dict(_INTERRUPTED_ERROR))
        except EngineError as e:
            logger.error("書き出しに失敗しました：%s（%s：%s）", job.id, e.code, e.message)
            job.fail(e.to_dict())
        except Exception as e:
            logger.exception("書き出し中に想定外のエラーが発生しました：%s", job.id)
            job.fail(_internal_error(e))
