"""EditAI バックエンドの起動用スクリプト。

使い方：cd backend → python main.py
http://127.0.0.1:8765/docs で API の一覧（Swagger UI）を確認できる。
"""

import logging

import uvicorn

from api import settings

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%H:%M:%S")
    # 127.0.0.1 だけで待ち受け、外部のネットワークには公開しない
    uvicorn.run("api.server:app", host=settings.HOST, port=settings.PORT, log_level="info")
