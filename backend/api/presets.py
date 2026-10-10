"""スタイルプリセットの保存（docs/01_api_schema.md 3.3・4.10）。ユーザーデータフォルダの presets.json に保存する。"""

from __future__ import annotations

import json
import os
import threading
import uuid
from pathlib import Path
from typing import Any

from core.errors import EngineError
from core.sub_exporter import SubtitleStyle

from .jobs import now_iso

PRESETS_FILE = "presets.json"

# 初回起動時に作るプリセット（UI モックと同じ内容）
_INITIAL_PRESETS: list[tuple[str, dict[str, Any]]] = [
    ("標準（白文字・黒縁）", {}),
    ("ゲーム実況（黄色・太縁）", {"font_size": 80, "primary_color": "#FFE600", "outline_width": 8}),
    (
        "ニュース風（背景ボックス）",
        {
            "font_size": 52,
            "bold": False,
            "background_enabled": True,
            "background_color": "#0B1F4D",
            "background_opacity": 0.85,
            "shadow_depth": 0,
        },
    ),
]


class PresetStore:
    def __init__(self, data_dir: Path) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / PRESETS_FILE
        self._lock = threading.Lock()
        if not self.path.exists():
            self._write([self._new(name, SubtitleStyle(**style)) for name, style in _INITIAL_PRESETS])

    # ---------- ファイル ----------

    def _read(self) -> list[dict[str, Any]]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8")).get("presets", [])
        except (OSError, ValueError) as e:
            raise EngineError("INTERNAL_ERROR", "プリセットを読み込めませんでした。", {"path": str(self.path), "reason": str(e)}) from e

    def _write(self, presets: list[dict[str, Any]]) -> None:
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps({"presets": presets}, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)

    @staticmethod
    def _new(name: str, style: SubtitleStyle) -> dict[str, Any]:
        now = now_iso()
        return {"id": str(uuid.uuid4()), "name": name, "style": style.model_dump(), "created_at": now, "updated_at": now}

    @staticmethod
    def _check_name(presets: list[dict[str, Any]], name: str, exclude_id: str | None = None) -> None:
        if any(p["name"] == name and p["id"] != exclude_id for p in presets):
            raise EngineError("PRESET_NAME_CONFLICT", f"「{name}」という名前のプリセットはすでにあります。", {"name": name})

    @staticmethod
    def _find(presets: list[dict[str, Any]], preset_id: str) -> dict[str, Any]:
        for preset in presets:
            if preset["id"] == preset_id:
                return preset
        raise EngineError("PRESET_NOT_FOUND", "指定されたプリセットが見つかりません。", {"preset_id": preset_id})

    # ---------- 操作 ----------

    def list_all(self) -> list[dict[str, Any]]:
        with self._lock:
            return self._read()

    def create(self, name: str, style: SubtitleStyle) -> dict[str, Any]:
        with self._lock:
            presets = self._read()
            self._check_name(presets, name)
            preset = self._new(name, style)
            presets.append(preset)
            self._write(presets)
            return preset

    def update(self, preset_id: str, name: str, style: SubtitleStyle) -> dict[str, Any]:
        with self._lock:
            presets = self._read()
            preset = self._find(presets, preset_id)
            self._check_name(presets, name, exclude_id=preset_id)
            preset.update(name=name, style=style.model_dump(), updated_at=now_iso())
            self._write(presets)
            return preset

    def delete(self, preset_id: str) -> None:
        with self._lock:
            presets = self._read()
            self._find(presets, preset_id)
            self._write([p for p in presets if p["id"] != preset_id])
