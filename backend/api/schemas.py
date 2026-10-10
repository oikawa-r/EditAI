"""リクエストの形（Pydantic）。docs/01_api_schema.md の 4.2・4.7・4.10 に対応する。"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, StringConstraints, model_validator

from core import llm_processor, transcriber
from core.sub_exporter import ExportSegment, HexColor, OutputOptions, SubtitleStyle


class SilenceOptionsIn(BaseModel):
    enabled: bool = True
    vad_threshold: float = Field(0.5, ge=0.0, le=1.0)
    min_silence_ms: int = Field(500, ge=0)
    padding_ms: int = Field(150, ge=0)


class TranscriptionOptionsIn(BaseModel):
    enabled: bool = True
    model: str = Field(transcriber.DEFAULT_MODEL, min_length=1)
    language: str = Field(transcriber.DEFAULT_LANGUAGE, min_length=1)


class LLMOptionsIn(BaseModel):
    enabled: bool = True
    model: str = Field(llm_processor.DEFAULT_MODEL, min_length=1)


class ProjectOptions(BaseModel):
    silence: SilenceOptionsIn = Field(default_factory=SilenceOptionsIn)
    transcription: TranscriptionOptionsIn = Field(default_factory=TranscriptionOptionsIn)
    llm: LLMOptionsIn = Field(default_factory=LLMOptionsIn)


class CreateProjectRequest(BaseModel):
    """POST /projects の方式A（ローカルパスを指定）。"""

    source_path: str = Field(min_length=1)
    options: ProjectOptions = Field(default_factory=ProjectOptions)


class ExportClip(BaseModel):
    """タイムライン上の1クリップ。docs/01_api_schema.md 4.7。"""

    id: str = Field(min_length=1)
    type: Literal["動画", "写真", "画像", "音声", "テロップ"]
    startTime: float = Field(ge=0)
    duration: float = Field(gt=0)
    sourcePath: str = ""
    sourceUrl: str = ""
    sourceStart: float = Field(0, ge=0)
    kept: bool = True
    x: float = 0
    y: float = 0
    scale: float = Field(100, gt=0)
    rotation: float = 0
    flipH: bool = False
    flipV: bool = False
    speed: float = Field(1, gt=0)
    volume: float = Field(100, ge=0, le=200)
    fadeIn: float = Field(0, ge=0)
    fadeOut: float = Field(0, ge=0)
    pitch: float = Field(0, ge=-12, le=12)
    chromaEnabled: bool = False
    chromaColor: HexColor = "#00ff00"
    width: float | None = Field(None, gt=0)
    height: float | None = Field(None, gt=0)
    text: str | None = None
    style: SubtitleStyle | None = None


class ExportTrack(BaseModel):
    """映像または音声の1トラック。画面の上が配列の先頭。"""

    id: str = Field(min_length=1)
    type: Literal["video", "audio"]
    name: str = ""
    muted: bool = False
    locked: bool = False
    clips: list[ExportClip] = Field(default_factory=list)


class ExportRequest(BaseModel):
    """POST /projects/{id}/exports の本体。タイムライン全体と、テロップ焼き込み用の文リスト。"""

    width: int = Field(ge=1)
    height: int = Field(ge=1)
    fps: float = Field(gt=0)
    tracks: list[ExportTrack]
    segments: list[ExportSegment]
    style: SubtitleStyle = Field(default_factory=SubtitleStyle)
    # 記録用。表示・非表示の判定には segments[].visible を使う
    importance_threshold: int | None = Field(None, ge=1, le=3)
    output: OutputOptions = Field(default_factory=OutputOptions)

    @model_validator(mode="after")
    def _timeline(self) -> ExportRequest:
        track_ids: set[str] = set()
        clip_ids: set[str] = set()
        for track in self.tracks:
            if track.id in track_ids:
                raise ValueError(f"トラック id が重複しています：{track.id}")
            track_ids.add(track.id)
            for clip in track.clips:
                if clip.id in clip_ids:
                    raise ValueError(f"クリップ id が重複しています：{clip.id}")
                clip_ids.add(clip.id)
                if clip.type != "テロップ" and not (clip.sourcePath.strip() or clip.sourceUrl.strip()):
                    raise ValueError(f"クリップ {clip.id} に sourcePath も sourceUrl もありません。")
        return self


class PresetRequest(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
    style: SubtitleStyle = Field(default_factory=SubtitleStyle)
