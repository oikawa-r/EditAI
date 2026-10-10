"""処理エンジン共通の例外。

code は docs/01_api_schema.md「2.1 エラーレスポンス」のエラーコードに合わせる。
"""

from __future__ import annotations

from typing import Any


class EngineError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}

    def to_dict(self) -> dict[str, Any]:
        """エラーレスポンスの error と同じ形。"""
        return {"code": self.code, "message": self.message, "details": self.details}


class CancelledByUser(Exception):
    """ユーザーが処理を中断した。API ではジョブの status を cancelled にする。"""
