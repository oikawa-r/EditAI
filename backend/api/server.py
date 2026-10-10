"""EditAI の API サーバー（FastAPI）。仕様は docs/01_api_schema.md を参照。

起動：cd backend → python main.py
"""

from __future__ import annotations

import importlib.util
import json
import logging
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, BinaryIO

from fastapi import APIRouter, FastAPI, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import ValidationError
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException

from core.errors import EngineError
from core.llm_processor import LLMProcessor
from core.media import ffmpeg_version
from core.silence_cutter import SUPPORTED_EXTENSIONS, validate_source
from core.transcriber import Transcriber

from . import settings
from .jobs import CUT_FILE, RESULT_FILE, JobManager, ProjectJob
from .presets import PresetStore
from .schemas import CreateProjectRequest, ExportRequest, PresetRequest, ProjectOptions

logger = logging.getLogger(__name__)

# docs/01_api_schema.md「2.1 エラーレスポンス」
_HTTP_STATUS = {
    "INVALID_REQUEST": 400,
    "UNSUPPORTED_FORMAT": 400,
    "FILE_NOT_FOUND": 404,
    "PROJECT_NOT_FOUND": 404,
    "EXPORT_NOT_FOUND": 404,
    "PRESET_NOT_FOUND": 404,
    "NOT_READY": 409,
    "ALREADY_RUNNING": 409,
    "PRESET_NAME_CONFLICT": 409,
    "OUTPUT_EXISTS": 409,
    "VALIDATION_ERROR": 422,
    "FFMPEG_ERROR": 500,
    "TRANSCRIPTION_ERROR": 500,
    "LLM_UNAVAILABLE": 503,
    "INTERNAL_ERROR": 500,
}

_UPLOAD_CHUNK = 1024 * 1024


class _State:
    jobs: JobManager
    presets: PresetStore


state = _State()


class _HideStatusAccessLog(logging.Filter):
    """GET /status のポーリング（1秒ごと）はアクセスログに出さない。"""

    def filter(self, record: logging.LogRecord) -> bool:
        path = record.args[2] if isinstance(record.args, tuple) and len(record.args) >= 3 else ""
        return not (isinstance(path, str) and path.split("?", 1)[0].endswith("/status"))


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # uvicorn を直接起動したときも、core のログ（進捗など）が表示されるようにする
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("uvicorn.access").addFilter(_HideStatusAccessLog())
    state.jobs = JobManager(settings.TEMP_DIR)
    state.presets = PresetStore(settings.DATA_DIR)
    logger.info("一時フォルダ：%s／ユーザーデータ：%s", settings.TEMP_DIR, settings.DATA_DIR)
    yield
    state.jobs.shutdown()


app = FastAPI(title="EditAI API", version=settings.VERSION, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_origin_regex=settings.CORS_ORIGIN_REGEX,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- エラーレスポンス ----------

def _error_response(status_code: int, code: str, message: str, details: Any = None) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message, "details": jsonable_encoder(details or {})}},
    )


@app.exception_handler(EngineError)
async def _handle_engine_error(_request: Request, exc: EngineError) -> JSONResponse:
    return _error_response(_HTTP_STATUS.get(exc.code, 500), exc.code, exc.message, exc.details)


@app.exception_handler(RequestValidationError)
async def _handle_validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    return _error_response(422, "VALIDATION_ERROR", "リクエストの値が正しくありません。", {"errors": exc.errors()})


@app.exception_handler(StarletteHTTPException)
async def _handle_http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
    return _error_response(exc.status_code, "INVALID_REQUEST", str(exc.detail))


@app.exception_handler(Exception)
async def _handle_unexpected(_request: Request, exc: Exception) -> JSONResponse:
    logger.exception("想定外のエラーが発生しました。")
    return _error_response(500, "INTERNAL_ERROR", "想定外のエラーが発生しました。", {"reason": repr(exc)})


def _validation_error(e: ValidationError) -> EngineError:
    return EngineError("VALIDATION_ERROR", "リクエストの値が正しくありません。", {"errors": json.loads(e.json(include_url=False))})


router = APIRouter(prefix=settings.API_PREFIX)


# ---------- 4.1 起動確認 ----------

@router.get("/health")
def health() -> dict[str, Any]:
    version = ffmpeg_version()
    try:
        ollama = {"available": True, "models": LLMProcessor().list_models()}
    except Exception:
        ollama = {"available": False, "models": []}
    whisper_available = importlib.util.find_spec("faster_whisper") is not None
    return {
        "status": "ok",
        "version": settings.VERSION,
        "dependencies": {
            "ffmpeg": {"available": version is not None, "version": version},
            "ollama": ollama,
            "whisper": {
                "available": whisper_available,
                "device": Transcriber().resolve_device() if whisper_available else None,
            },
        },
    }


# ---------- 4.2〜4.6 プロジェクト（解析） ----------

def _created(job: ProjectJob) -> dict[str, Any]:
    return {"project_id": job.id, "status": job.status, "created_at": job.created_at}


def _parse_options(raw: Any) -> ProjectOptions:
    if raw in (None, ""):
        return ProjectOptions()
    try:
        return ProjectOptions.model_validate(json.loads(raw))
    except json.JSONDecodeError as e:
        raise EngineError("INVALID_REQUEST", "options を JSON として読めません。", {"reason": str(e)}) from e
    except ValidationError as e:
        raise _validation_error(e) from e


def _save_upload(source: BinaryIO, dest: Path) -> None:
    with dest.open("wb") as f:
        shutil.copyfileobj(source, f, _UPLOAD_CHUNK)


async def _create_from_upload(request: Request) -> dict[str, Any]:
    """方式B：multipart/form-data で動画ファイルを直接受け取る。"""
    form = await request.form()
    upload = form.get("file")
    if not isinstance(upload, UploadFile):
        raise EngineError("INVALID_REQUEST", "file に動画ファイルを指定してください。")
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise EngineError(
            "UNSUPPORTED_FORMAT",
            "対応していない動画形式です。",
            {"file_name": upload.filename, "supported": sorted(SUPPORTED_EXTENSIONS)},
        )
    options = _parse_options(form.get("options"))

    project_id, work_dir = state.jobs.new_project_dir()
    dest = work_dir / f"source{suffix}"
    try:
        await run_in_threadpool(_save_upload, upload.file, dest)
    except BaseException:
        state.jobs.discard_project_dir(work_dir)
        raise
    finally:
        await upload.close()
    return _created(state.jobs.submit_project(project_id, work_dir, dest, options))


@router.post("/projects", status_code=202)
async def create_project(request: Request) -> dict[str, Any]:
    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        return await _create_from_upload(request)

    # 方式A：application/json でローカルのファイルパスを受け取る
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise EngineError("INVALID_REQUEST", "リクエストを JSON として読めません。", {"reason": str(e)}) from e
    try:
        req = CreateProjectRequest.model_validate(body)
    except ValidationError as e:
        raise _validation_error(e) from e

    source = Path(req.source_path).expanduser().resolve()
    validate_source(source)
    project_id, work_dir = state.jobs.new_project_dir()
    return _created(state.jobs.submit_project(project_id, work_dir, source, req.options))


@router.get("/projects/{project_id}/status")
def project_status(project_id: str) -> dict[str, Any]:
    return state.jobs.get_project(project_id).status_response()


@router.post("/projects/{project_id}/cancel")
def cancel_project(project_id: str) -> dict[str, Any]:
    job = state.jobs.cancel_project(project_id)
    return {"project_id": job.id, "status": job.status}


@router.get("/projects/{project_id}/result")
def project_result(project_id: str) -> JSONResponse:
    job = state.jobs.get_project(project_id)
    result_path = job.dir / RESULT_FILE
    if job.status != "completed" or not result_path.is_file():
        raise EngineError("NOT_READY", "解析がまだ終わっていません。", {"project_id": project_id, "status": job.status})
    return JSONResponse(json.loads(result_path.read_text(encoding="utf-8")))


@router.get("/projects/{project_id}/media/preview")
def project_preview(project_id: str) -> FileResponse:
    job = state.jobs.get_project(project_id)
    cut_path = job.dir / CUT_FILE
    # cut.mp4 は完成してから今の名前になるので、あればステップ1は終わっている
    if not cut_path.is_file():
        raise EngineError("NOT_READY", "無音カット後の動画がまだできていません。", {"project_id": project_id})
    # FileResponse は Range リクエストに対応しているので、<video> でシークできる
    return FileResponse(cut_path, media_type="video/mp4")


# ---------- 4.7〜4.9 書き出し ----------

@router.post("/projects/{project_id}/exports", status_code=202)
def create_export(project_id: str, request: ExportRequest) -> dict[str, Any]:
    # FastAPI が ExportRequest で幅・高さ・fps・tracks・segments を検証してからここに入る
    project = state.jobs.get_project(project_id)
    job = state.jobs.submit_export(project, request)
    return {"export_id": job.id, "project_id": project_id, "status": job.status}


@router.get("/projects/{project_id}/exports/{export_id}")
def export_status(project_id: str, export_id: str) -> dict[str, Any]:
    return state.jobs.get_export(project_id, export_id).status_response()


@router.get("/projects/{project_id}/exports/{export_id}/download")
def export_download(project_id: str, export_id: str) -> FileResponse:
    job = state.jobs.get_export(project_id, export_id)
    status = job.status_response()
    if status["status"] != "completed" or not status["output_path"]:
        raise EngineError("NOT_READY", "書き出しがまだ終わっていません。", {"export_id": export_id, "status": status["status"]})
    path = Path(status["output_path"])
    if not path.is_file():
        raise EngineError("FILE_NOT_FOUND", "書き出した動画が見つかりません（移動または削除された可能性があります）。", {"path": str(path)})
    return FileResponse(path, media_type="video/mp4", filename=path.name)


# ---------- 4.10 スタイルプリセット ----------

@router.get("/style-presets")
def list_presets() -> dict[str, Any]:
    return {"presets": state.presets.list_all()}


@router.post("/style-presets", status_code=201)
def create_preset(request: PresetRequest) -> dict[str, Any]:
    return state.presets.create(request.name, request.style)


@router.put("/style-presets/{preset_id}")
def update_preset(preset_id: str, request: PresetRequest) -> dict[str, Any]:
    return state.presets.update(preset_id, request.name, request.style)


@router.delete("/style-presets/{preset_id}", status_code=204)
def delete_preset(preset_id: str) -> Response:
    state.presets.delete(preset_id)
    return Response(status_code=204)


app.include_router(router)
