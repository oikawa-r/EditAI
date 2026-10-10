"""API サーバーの設定。環境変数で変更できる。"""

from __future__ import annotations

import os
from pathlib import Path

VERSION = "0.1.0"
HOST = "127.0.0.1"
PORT = int(os.environ.get("EDITAI_PORT", "8765"))
API_PREFIX = "/api/v1"

# EditAI/（backend/api/settings.py の2つ上）
_ROOT = Path(__file__).resolve().parents[2]

# 処理中の一時ファイル（プロジェクトごとのフォルダ）
TEMP_DIR = Path(os.environ.get("EDITAI_TEMP_DIR") or _ROOT / "temp").resolve()


def _default_data_dir() -> Path:
    appdata = os.environ.get("APPDATA")
    return Path(appdata) / "EditAI" if appdata else Path.home() / ".editai"


# アプリを再起動しても残すデータ（presets.json など）
DATA_DIR = Path(os.environ.get("EDITAI_DATA_DIR") or _default_data_dir()).resolve()

# docs/01_api_schema.md「2. 共通仕様」の CORS
CORS_ORIGINS = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    # file:// で開いたページは、オリジンが "null" として送られる
    "null",
]
CORS_ORIGIN_REGEX = r"^http://(localhost|127\.0\.0\.1)(:\d+)?$"
