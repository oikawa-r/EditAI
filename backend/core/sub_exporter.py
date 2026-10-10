"""ステップ5：テロップの焼き込みと、タイムラインの合成（書き出し）。

`export` は確定した文リストとスタイルから ASS 字幕を作り、FFmpeg で cut.mp4 に焼き込む。
`export_timeline` は ExportRequest のトラックから filter_complex を組み立て、黒画面の上に
動画と画像を重ね、音声をミックスする。拡縮・回転・反転・座標・速度・音量・フェード・音程・
クロマキーを反映し、最後に `.ass` のテロップを焼き込む。
仕様は docs/06_export_video.md と docs/01_api_schema.md の 4.7 を参照。
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import re
import threading
import time
import unicodedata
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Any, Callable, Literal, Sequence, TypeVar
from urllib.parse import unquote, urlparse

from pydantic import BaseModel, Field, ValidationError, model_validator

from .errors import CancelledByUser, EngineError
from .media import StreamInfo, ffmpeg_filter_names, filter_complex_args, probe, probe_streams, run_ffmpeg

if TYPE_CHECKING:
    from api.schemas import ExportClip, ExportRequest

logger = logging.getLogger(__name__)

CUT_FILE = "cut.mp4"
EXPORTS_DIR = "exports"

# 進捗（0〜100）と、API の exports の status
_PROGRESS_ASS = (0.0, 5.0, "generating_ass")
_PROGRESS_ENCODE = (5.0, 100.0, "encoding")
_LOG_STEP_PERCENT = 10

# 行の先頭に来てはいけない文字（前の行の末尾に付ける）
_NO_LINE_START = set("、。，．,.!！?？…‥ー～)）]］｝〕〉》」』】”’・ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ")

# 背景ボックスの内側の余白（font_size に対する割合）。プレビューの上下の余白に合わせている
_BOX_PADDING_RATIO = 0.15

# 進捗（0〜100）と状態（generating_ass / encoding）を受け取る関数
ExportProgressCallback = Callable[[float, str], None]

HexColor = Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")]
Opacity = Annotated[float, Field(ge=0.0, le=1.0)]
# FFmpeg の引数にそのまま渡すので、"-" で始まる値（別のオプションとして解釈される）や記号を受け付けない
FFmpegName = Annotated[str, Field(pattern=r"^[A-Za-z0-9_][A-Za-z0-9_.-]*$")]


# ---------- 入力のモデル（docs/01_api_schema.md 3.2・4.7） ----------

class SubtitleStyle(BaseModel):
    # ASS のスタイル行はカンマ区切りなので、フォント名にカンマは使えない
    font_family: str = Field("Noto Sans JP", min_length=1, pattern=r"^[^,\r\n]+$")
    font_size: int = Field(64, ge=8, le=300)
    bold: bool = True
    italic: bool = False
    primary_color: HexColor = "#FFFFFF"
    primary_opacity: Opacity = 1.0
    outline_color: HexColor = "#000000"
    outline_opacity: Opacity = 1.0
    outline_width: float = Field(4.0, ge=0, le=20)
    shadow_color: HexColor = "#000000"
    shadow_opacity: Opacity = 0.5
    shadow_depth: float = Field(2.0, ge=0, le=20)
    background_enabled: bool = False
    background_color: HexColor = "#000000"
    background_opacity: Opacity = 0.6
    alignment: int = Field(2, ge=1, le=9)
    margin_v: int = Field(60, ge=0, le=1000)
    margin_h: int = Field(40, ge=0, le=1000)
    letter_spacing: float = Field(0.0, ge=-10, le=50)


class ExportSegment(BaseModel):
    id: str = Field(min_length=1)
    start: float = Field(ge=0)
    end: float
    visible: bool
    selected_variant: Literal["original", "summary", "impact", "custom"]
    text: str

    @model_validator(mode="after")
    def _check(self) -> ExportSegment:
        if self.start >= self.end:
            raise ValueError("start は end より小さくしてください。")
        if self.visible and not self.text.strip():
            raise ValueError("表示する文（visible: true）の text が空です。")
        return self


class OutputOptions(BaseModel):
    path: str | None = None
    overwrite: bool = False
    video_codec: FFmpegName = "libx264"
    crf: int = Field(20, ge=0, le=51)
    preset: FFmpegName = "medium"
    audio_codec: FFmpegName = "aac"
    audio_bitrate: str = Field("192k", pattern=r"^\d+[kKmM]?$")


@dataclass(frozen=True)
class ExportResult:
    export_id: str
    output_path: Path
    ass_path: Path
    visible_count: int
    duration: float


_Model = TypeVar("_Model", bound=BaseModel)


def _validation_error(errors: list[dict[str, Any]]) -> EngineError:
    return EngineError("VALIDATION_ERROR", "書き出しの設定に誤りがあります。", {"errors": errors})


def _coerce(model: type[_Model], value: _Model | dict[str, Any] | None, loc: str) -> _Model:
    if isinstance(value, model):
        return value
    try:
        return model.model_validate(value or {})
    except ValidationError as e:
        errors = json.loads(e.json(include_url=False))
        for error in errors:
            error["loc"] = [loc, *error.get("loc", [])]
        raise _validation_error(errors) from e


def validate_segments(segments: Sequence[ExportSegment | dict[str, Any]]) -> list[ExportSegment]:
    result = [_coerce(ExportSegment, seg, f"segments[{i}]") for i, seg in enumerate(segments)]
    seen: set[str] = set()
    duplicates: set[str] = set()
    for seg in result:
        if seg.id in seen:
            duplicates.add(seg.id)
        seen.add(seg.id)
    if duplicates:
        raise _validation_error([{"loc": ["segments"], "msg": "id が重複しています。", "input": sorted(duplicates)}])
    return result


# ---------- ASS の生成 ----------

def ass_color(hex_color: str, opacity: float) -> str:
    """#RRGGBB と不透明度を ASS の &HAABBGGRR にする（アルファは 00 が不透明、FF が透明）。"""
    r, g, b = hex_color[1:3], hex_color[3:5], hex_color[5:7]
    alpha = round((1.0 - opacity) * 255)
    return f"&H{alpha:02X}{b.upper()}{g.upper()}{r.upper()}"


def ass_time(seconds: float) -> str:
    """秒を ASS の時刻（H:MM:SS.cc）にする。"""
    cs = max(round(seconds * 100), 0)
    h, rest = divmod(cs, 360_000)
    m, rest = divmod(rest, 6_000)
    s, cs = divmod(rest, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _num(value: float) -> str:
    return f"{value:g}"


def _char_width(ch: str) -> float:
    """全角を 1、半角を 0.5 として数える。"""
    return 0.5 if unicodedata.east_asian_width(ch) in ("Na", "H") else 1.0


def wrap_line(line: str, max_units: float) -> list[str]:
    """1行に収まらない文を、なるべく均等な長さの複数行に分ける（docs/06_export_video.md 3.4）。"""
    total = sum(_char_width(ch) for ch in line)
    if total <= max_units or len(line) <= 1:
        return [line]

    count = math.ceil(total / max_units)
    target = total / count
    lines: list[str] = []
    current = ""
    width = 0.0
    for ch in line:
        w = _char_width(ch)
        if current and width + w > target and len(lines) < count - 1 and ch not in _NO_LINE_START:
            lines.append(current.strip())
            current, width = "", 0.0
        current += ch
        width += w
    lines.append(current.strip())
    return [ln for ln in lines if ln]


def escape_ass_text(text: str) -> str:
    """ASS で特別な意味を持つ記号を全角にする（{ } は装飾タグ、\\ は改行などの記号になるため）。"""
    return text.replace("\\", "＼").replace("{", "｛").replace("}", "｝")


def format_text(text: str, max_units: float) -> str:
    text = escape_ass_text(text).replace("\r\n", "\n").replace("\r", "\n")
    lines: list[str] = []
    for line in text.split("\n"):
        lines.extend(wrap_line(line.strip(), max_units))
    return r"\N".join(lines)


def max_line_units(style: SubtitleStyle, video_width: int) -> float:
    """1行に入る全角文字数の目安。"""
    char_width = style.font_size + style.letter_spacing
    available = video_width - style.margin_h * 2
    if char_width <= 0 or available <= 0:
        return math.inf
    return max(available / char_width, 1.0)


def build_style_line(style: SubtitleStyle) -> str:
    primary = ass_color(style.primary_color, style.primary_opacity)
    back = ass_color(style.shadow_color, style.shadow_opacity)
    if style.background_enabled:
        # BorderStyle=3 では、OutlineColour が箱の色、Outline が箱の内側の余白になる
        border_style = 3
        outline_colour = ass_color(style.background_color, style.background_opacity)
        outline = style.font_size * _BOX_PADDING_RATIO
    else:
        border_style = 1
        outline_colour = ass_color(style.outline_color, style.outline_opacity)
        outline = style.outline_width

    fields = [
        "Default", style.font_family, str(style.font_size),
        primary, primary, outline_colour, back,
        "-1" if style.bold else "0", "-1" if style.italic else "0", "0", "0",
        "100", "100", _num(style.letter_spacing), "0",
        str(border_style), _num(outline), _num(style.shadow_depth),
        str(style.alignment), str(style.margin_h), str(style.margin_h), str(style.margin_v),
        "1",
    ]
    return "Style: " + ",".join(fields)


def build_ass(segments: list[ExportSegment], style: SubtitleStyle, width: int, height: int) -> str:
    max_units = max_line_units(style, width)
    events: list[str] = []
    for seg in sorted((s for s in segments if s.visible), key=lambda s: s.start):
        start = ass_time(seg.start)
        end = ass_time(seg.end)
        if end == start:
            end = ass_time(seg.start + 0.01)
        events.append(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{format_text(seg.text, max_units)}")

    return "\n".join([
        "[Script Info]",
        "; EditAI で生成",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: None",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        build_style_line(style),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        *events,
        "",
    ])


# ---------- 書き出し ----------

def _encode_args(options: OutputOptions) -> list[str]:
    args = ["-c:v", options.video_codec]
    if "nvenc" in options.video_codec:
        # NVENC は -crf に対応していないので、同じ意味の -cq を使う
        args += ["-rc", "vbr", "-cq", str(options.crf), "-b:v", "0"]
    else:
        args += ["-crf", str(options.crf)]
    args += ["-preset", options.preset, "-pix_fmt", "yuv420p"]
    if options.audio_codec == "copy":
        args += ["-c:a", "copy"]
    else:
        args += ["-c:a", options.audio_codec, "-b:a", options.audio_bitrate]
    return args + ["-movflags", "+faststart"]


# ---------- タイムラインの合成（filter_complex） ----------

_IMAGE_TYPES = frozenset({"写真", "画像"})
_VISUAL_TYPES = frozenset({"動画", "写真", "画像"})
_AUDIO_TYPES = frozenset({"動画", "音声"})
_AUDIO_RATE = 48_000


@dataclass(frozen=True)
class TimelineMedia:
    """合成に使う1クリップの素材。width と height は映像の元の解像度。"""

    path: Path
    is_image: bool
    has_audio: bool
    width: int = 0
    height: int = 0


@dataclass(frozen=True)
class TimelineGraph:
    """FFmpeg に渡す入力と filter_complex、出力の長さ（秒）。"""

    input_args: list[str]
    filter_complex: str
    duration: float


def _ff(value: float) -> str:
    """フィルターに渡す秒・フレームレート。科学記数法や余分な 0 を付けない。"""
    text = f"{value:.6f}".rstrip("0").rstrip(".")
    if text in ("", "-0"):
        return "0"
    return text


def _path_from_source_url(url: str) -> Path | None:
    """Tauri の asset URL や file URL をローカルパスにする。blob: は読めないので None。"""
    url = url.strip()
    if not url or url.startswith("blob:"):
        return None
    parsed = urlparse(url)
    if parsed.scheme == "file":
        raw = unquote(parsed.path)
    elif parsed.scheme in ("http", "https") and (parsed.hostname or "").lower() == "asset.localhost":
        raw = unquote(parsed.path)
    else:
        return None
    raw = raw.replace("\\", "/")
    if len(raw) >= 3 and raw[0] == "/" and raw[1].isalpha() and raw[2] == ":":
        raw = raw[1:]
    if not raw:
        return None
    return Path(raw)


def resolve_media_path(source_path: str, source_url: str) -> Path:
    """sourcePath を優先し、無ければ sourceUrl から実在するファイルを探す。"""
    candidates: list[Path] = []
    if source_path.strip():
        candidates.append(Path(source_path.strip()))
    from_url = _path_from_source_url(source_url)
    if from_url is not None:
        candidates.append(from_url)
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise EngineError(
        "FILE_NOT_FOUND",
        "クリップの素材ファイルを読めません。書き出しにはローカルのファイルパスが必要です。",
        {"sourcePath": source_path, "sourceUrl": source_url},
    )


def _timeline_duration(request: ExportRequest) -> float:
    """全クリップの終端。クリップが無いときは1フレーム分にする。"""
    end = 0.0
    for track in request.tracks:
        for clip in track.clips:
            end = max(end, clip.startTime + clip.duration)
    if end <= 0:
        end = 1.0 / request.fps
    return end


def _visual_clips(request: ExportRequest) -> list[ExportClip]:
    """動画・画像。配列の先頭トラックが一番上なので、下のトラックから順に返す。"""
    clips: list[ExportClip] = []
    for track in reversed([item for item in request.tracks if item.type == "video"]):
        for clip in track.clips:
            if clip.type in _VISUAL_TYPES:
                clips.append(clip)
    return clips


def _clip_speed(clip: ExportClip) -> float:
    return clip.speed if clip.speed > 0 else 1.0


def _source_duration(clip: ExportClip) -> float:
    """タイムライン上の長さを、速度を掛ける前の素材の長さに戻す。"""
    return clip.duration * _clip_speed(clip)


def _even(value: float) -> int:
    """yuv420p に合わせ、2 以上の偶数にする。"""
    size = max(2, int(round(value)))
    if size % 2:
        size += 1
    return size


def _hex_color(value: str) -> str:
    return "0x" + value[1:].upper()


def _atempo_filters(speed: float) -> list[str]:
    """atempo は 0.5〜2.0 だけなので、範囲を超える速度は分割してつなぐ。"""
    if abs(speed - 1.0) < 0.0001:
        return []
    filters: list[str] = []
    remaining = speed
    while remaining > 2.0 + 1e-6:
        filters.append("atempo=2")
        remaining /= 2.0
    while remaining < 0.5 - 1e-6:
        filters.append("atempo=0.5")
        remaining /= 0.5
    if abs(remaining - 1.0) >= 0.0001:
        filters.append(f"atempo={_ff(remaining)}")
    return filters


def _pitch_filters(semitones: float) -> list[str]:
    """半音をピッチ倍率にする。rubberband が無いときは asetrate と atempo で長さを戻す。"""
    if abs(semitones) < 0.01:
        return []
    ratio = 2 ** (semitones / 12.0)
    if "rubberband" in ffmpeg_filter_names():
        return [f"rubberband=pitch={_ff(ratio)}"]
    return [
        f"asetrate={_ff(_AUDIO_RATE * ratio)}",
        *_atempo_filters(1.0 / ratio),
        f"aresample={_AUDIO_RATE}",
    ]


def _visual_filters(clip: ExportClip, info: TimelineMedia) -> str:
    """1本の映像クリップを、速度を戻した長さで切ってから変形し、開始時刻へ置く。"""
    speed = _clip_speed(clip)
    chain = [
        f"trim=start={_ff(clip.sourceStart)}:duration={_ff(_source_duration(clip))}",
        # trim 直後の PTS は sourceStart から始まるので、0 に戻してから 1/speed を掛ける
        f"setpts={_ff(1.0 / speed)}*(PTS-STARTPTS)",
    ]
    if info.width > 0 and info.height > 0 and abs(clip.scale - 100) >= 0.05:
        chain.append(
            f"scale={_even(info.width * clip.scale / 100)}:{_even(info.height * clip.scale / 100)}"
        )
    if clip.flipH:
        chain.append("hflip")
    if clip.flipV:
        chain.append("vflip")
    if abs(clip.rotation) >= 0.01:
        # 画面の回転は時計回り。FFmpeg の rotate は逆向きなので符号を反転する
        radians = -clip.rotation * math.pi / 180.0
        text = _ff(radians)
        chain.append("format=yuva420p")
        chain.append(f"rotate={text}:ow='rotw({text})':oh='roth({text})':c=none")
    if clip.chromaEnabled:
        chain.append(f"format=rgba,colorkey={_hex_color(clip.chromaColor)}:0.3:0.1,format=yuva420p")
    elif abs(clip.rotation) < 0.01:
        chain.append("format=yuv420p")
    chain.append(f"setpts=PTS+{_ff(clip.startTime)}/TB")
    chain.append("setsar=1")
    return ",".join(chain)


def _overlay_xy(clip: ExportClip) -> str:
    """画面中央が原点（右・下が正）を、overlay の左上原点に変換する。"""
    return f"x='W/2-w/2+({_ff(clip.x)})':y='H/2-h/2+({_ff(clip.y)})'"


def _audio_filters(clip: ExportClip) -> str:
    """速度を掛ける前の長さを切ってから、速度・音量・フェード・音程を掛け、開始時刻へ遅らせる。"""
    speed = _clip_speed(clip)
    chain = [
        f"aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates={_AUDIO_RATE}",
        f"atrim=start={_ff(clip.sourceStart)}:duration={_ff(_source_duration(clip))}",
        "asetpts=PTS-STARTPTS",
        *_atempo_filters(speed),
        f"volume={_ff(clip.volume / 100.0)}",
    ]
    fade_in = min(max(clip.fadeIn, 0.0), clip.duration)
    fade_out = min(max(clip.fadeOut, 0.0), max(clip.duration - fade_in, 0.0))
    if fade_in > 0:
        chain.append(f"afade=t=in:st=0:d={_ff(fade_in)}")
    if fade_out > 0:
        chain.append(f"afade=t=out:st={_ff(max(clip.duration - fade_out, 0.0))}:d={_ff(fade_out)}")
    chain.extend(_pitch_filters(clip.pitch))
    chain.append(f"adelay={max(round(clip.startTime * 1000), 0)}:all=1")
    return ",".join(chain)


def _audio_clips(request: ExportRequest) -> list[ExportClip]:
    """ミュートされていないトラックの動画・音声クリップ。"""
    clips: list[ExportClip] = []
    for track in request.tracks:
        if track.muted:
            continue
        for clip in track.clips:
            if clip.type in _AUDIO_TYPES:
                clips.append(clip)
    return clips


def _ass_filename(name: str) -> str:
    """ass フィルターには、exports フォルダからのファイル名だけを渡す。"""
    if not re.fullmatch(r"[A-Za-z0-9_-]+\.ass", name):
        raise ValueError("字幕ファイル名には英数字・ハイフン・アンダースコアだけを使ってください。")
    return name


def build_timeline_graph(
    request: ExportRequest,
    media: dict[str, TimelineMedia],
    *,
    ass_filename: str | None = None,
) -> TimelineGraph:
    """黒背景と無音を土台に、クリップを時間位置どおり重ねる filter_complex を作る。

    映像トラックは配列の先頭が一番上になるよう、最後に overlay する。
    ass_filename を渡すと、合成の最後（一番手前）にその字幕を焼く。パスは付けない。
    """
    duration = _timeline_duration(request)
    duration_text = _ff(duration)
    fps_text = _ff(request.fps)
    color = f"color=c=black:s={request.width}x{request.height}:r={fps_text}:d={duration_text}"
    silence = f"anullsrc=channel_layout=stereo:sample_rate={_AUDIO_RATE}"
    input_args = [
        "-f", "lavfi", "-t", duration_text, "-i", color,
        "-f", "lavfi", "-t", duration_text, "-i", silence,
    ]

    files: list[tuple[Path, bool, float]] = []
    index_of: dict[tuple[Path, bool], int] = {}

    def input_index(info: TimelineMedia, span: float) -> int:
        key = (info.path, info.is_image)
        found = index_of.get(key)
        if found is not None:
            return found
        index = 2 + len(files)
        files.append((info.path, info.is_image, span))
        index_of[key] = index
        return index

    visual = _visual_clips(request)
    audible = [clip for clip in _audio_clips(request) if media[clip.id].has_audio]
    image_span: dict[Path, float] = {}
    for clip in visual:
        info = media[clip.id]
        if info.is_image:
            image_span[info.path] = max(
                image_span.get(info.path, 0.0), clip.sourceStart + _source_duration(clip)
            )

    for clip in [*visual, *audible]:
        info = media[clip.id]
        span = image_span.get(info.path, clip.sourceStart + _source_duration(clip)) if info.is_image else 0.0
        input_index(info, span)

    for path, is_image, span in files:
        if is_image:
            length = max(span, 1.0 / request.fps)
            input_args += ["-loop", "1", "-framerate", fps_text, "-t", _ff(length), "-i", str(path)]
        else:
            input_args += ["-i", str(path)]

    filters: list[str] = []
    # 字幕を焼くときは、合成結果を vcomp にしてから一番手前で ass を掛ける
    video_label = "vcomp" if ass_filename else "vout"
    if not visual:
        filters.append(f"[0:v]setsar=1,format=yuv420p[{video_label}]")
    else:
        filters.append("[0:v]setsar=1,format=yuv420p[base0]")
        current = "base0"
        for index, clip in enumerate(visual):
            info = media[clip.id]
            label = f"v{index}"
            start = _ff(clip.startTime)
            end = _ff(clip.startTime + clip.duration)
            filters.append(f"[{input_index(info, 0)}:v]{_visual_filters(clip, info)}[{label}]")
            output = video_label if index == len(visual) - 1 else f"base{index + 1}"
            # 配列の先頭トラックほど後から重ねるので、一番上が手前に来る
            filters.append(
                f"[{current}][{label}]overlay={_overlay_xy(clip)}:"
                f"eof_action=pass:enable='between(t,{start},{end})'[{output}]"
            )
            current = output
    if ass_filename:
        filters.append(f"[{video_label}]ass=filename={_ass_filename(ass_filename)}[vout]")

    if not audible:
        filters.append(
            f"[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates={_AUDIO_RATE},"
            f"atrim=duration={duration_text},asetpts=PTS-STARTPTS[aout]"
        )
    else:
        filters.append(
            f"[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates={_AUDIO_RATE},"
            f"atrim=duration={duration_text},asetpts=PTS-STARTPTS[sil]"
        )
        audio_labels = ["sil"]
        for index, clip in enumerate(audible):
            info = media[clip.id]
            label = f"a{index}"
            filters.append(f"[{input_index(info, 0)}:a]{_audio_filters(clip)}[{label}]")
            audio_labels.append(label)
        pads = "".join(f"[{label}]" for label in audio_labels)
        # 無音を先頭にして、キャンバスの長さで打ち切る。normalize=0 で音量を割り算しない
        filters.append(
            f"{pads}amix=inputs={len(audio_labels)}:duration=first:dropout_transition=0:normalize=0[aout]"
        )

    return TimelineGraph(input_args, ";".join(filters), duration)


def _load_timeline_media(request: ExportRequest) -> dict[str, TimelineMedia]:
    """映像・音声に使うクリップのファイルを開き、ストリームの有無を調べる。"""
    needed: list[ExportClip] = []
    seen: set[str] = set()
    for clip in [*_visual_clips(request), *_audio_clips(request)]:
        if clip.id in seen:
            continue
        seen.add(clip.id)
        needed.append(clip)

    media: dict[str, TimelineMedia] = {}
    probed: dict[Path, StreamInfo] = {}
    for clip in needed:
        try:
            path = resolve_media_path(clip.sourcePath, clip.sourceUrl)
        except EngineError as e:
            e.details = {**e.details, "clip_id": clip.id}
            raise
        streams = probed.get(path)
        if streams is None:
            streams = probe_streams(path)
            probed[path] = streams
        has_video, has_audio = streams.has_video, streams.has_audio
        is_image = clip.type in _IMAGE_TYPES
        if clip.type == "動画" and not has_video:
            raise EngineError(
                "UNSUPPORTED_FORMAT",
                "映像が含まれていない動画です。",
                {"clip_id": clip.id, "path": str(path)},
            )
        if clip.type == "音声" and not has_audio:
            raise EngineError(
                "UNSUPPORTED_FORMAT",
                "音声が含まれていないファイルです。",
                {"clip_id": clip.id, "path": str(path)},
            )
        if is_image and not has_video:
            raise EngineError(
                "UNSUPPORTED_FORMAT",
                "画像として読み込めないファイルです。",
                {"clip_id": clip.id, "path": str(path)},
            )
        media[clip.id] = TimelineMedia(path, is_image, has_audio, streams.width, streams.height)
    return media


class SubExporter:
    """テロップの焼き込みと、タイムラインの filter_complex 合成を行う。"""

    def export(
        self,
        video_path: str | Path,
        segments: Sequence[ExportSegment | dict[str, Any]],
        style: SubtitleStyle | dict[str, Any] | None = None,
        output: OutputOptions | dict[str, Any] | None = None,
        *,
        export_dir: str | Path | None = None,
        export_id: str | None = None,
        on_progress: ExportProgressCallback | None = None,
        cancel_event: threading.Event | None = None,
    ) -> ExportResult:
        """video_path（cut.mp4）にテロップを焼き込んだ動画を書き出す。

        export_dir には .ass（と、output.path を省略したときの動画）を保存する。省略時は動画と同じフォルダの exports/。
        on_progress には進捗（0〜100）と状態（generating_ass / encoding）を渡す。
        cancel_event がセットされると CancelledByUser を送出する。
        """
        started = time.monotonic()
        seg_list = validate_segments(segments)
        style_model = _coerce(SubtitleStyle, style, "style")
        output_model = _coerce(OutputOptions, output, "output")
        export_id = export_id or str(uuid.uuid4())
        # .ass はファイル名だけで FFmpeg に渡すので、記号を含む名前にしない
        if not re.fullmatch(r"[A-Za-z0-9_-]+", export_id):
            raise ValueError("export_id には英数字・ハイフン・アンダースコアだけを使ってください。")

        # FFmpeg は .ass のフォルダで起動するので、相対パスはここで絶対パスにしておく
        video = Path(video_path).resolve()
        if not video.is_file():
            raise EngineError(
                "FILE_NOT_FOUND",
                "無音カット後の動画（cut.mp4）が見つかりません。先にステップ1を実行してください。",
                {"path": str(video)},
            )
        exports = Path(export_dir).resolve() if export_dir else video.parent / EXPORTS_DIR
        output_path = Path(output_model.path).resolve() if output_model.path else exports / f"{export_id}.mp4"
        if output_path.exists() and not output_model.overwrite:
            raise EngineError(
                "OUTPUT_EXISTS",
                "書き出し先に同じ名前のファイルがあります。",
                {"path": str(output_path)},
            )

        media = probe(video)
        visible_count = sum(1 for s in seg_list if s.visible)
        logger.info(
            "書き出しを開始します：テロップ %d/%d 文、%dx%d、%.1f 秒",
            visible_count, len(seg_list), media.width, media.height, media.duration,
        )
        if visible_count == 0:
            logger.warning("表示するテロップがありません。テロップなしで書き出します。")

        # 1. .ass を作る
        ass_start, ass_end, ass_status = _PROGRESS_ASS
        if on_progress:
            on_progress(ass_start, ass_status)
        exports.mkdir(parents=True, exist_ok=True)
        ass_path = exports / f"{export_id}.ass"
        # BOM 付き UTF-8 にしておくと、Aegisub などの字幕ソフトで開いたときも文字化けしない
        ass_path.write_text(build_ass(seg_list, style_model, media.width, media.height), encoding="utf-8-sig")
        logger.info(".ass を保存しました：%s", ass_path)
        if on_progress:
            on_progress(ass_end, ass_status)

        # 2. 焼き込む
        output_path.parent.mkdir(parents=True, exist_ok=True)
        # 途中で失敗・中断しても壊れた動画が残らないよう、別名で書いてから名前を変える
        partial_path = output_path.with_name(f"{output_path.stem}.partial{output_path.suffix}")
        try:
            run_ffmpeg(
                [
                    "-i", str(video),
                    "-vf", f"ass=filename={ass_path.name}",
                    *_encode_args(output_model),
                    str(partial_path),
                ],
                total_duration=media.duration,
                on_progress=self._encode_progress(on_progress),
                cancel_event=cancel_event,
                cwd=exports,
            )
        except BaseException:
            partial_path.unlink(missing_ok=True)
            raise
        try:
            os.replace(partial_path, output_path)
        except OSError as e:
            partial_path.unlink(missing_ok=True)
            raise EngineError(
                "INTERNAL_ERROR",
                "書き出し先のファイルを置き換えられませんでした。ほかのアプリで開いていないか確認してください。",
                {"path": str(output_path), "reason": str(e)},
            ) from e

        logger.info("書き出しが完了しました：%s（%.1f 秒）", output_path, time.monotonic() - started)
        return ExportResult(export_id, output_path, ass_path, visible_count, media.duration)

    @staticmethod
    def _encode_progress(on_progress: ExportProgressCallback | None) -> Callable[[float], None]:
        start, end, status = _PROGRESS_ENCODE
        next_log = _LOG_STEP_PERCENT

        def report(ratio: float) -> None:
            nonlocal next_log
            if on_progress:
                on_progress(start + (end - start) * ratio, status)
            percent = ratio * 100
            if percent >= next_log:
                logger.info("エンコード中… %d%%", int(percent))
                next_log = (int(percent) // _LOG_STEP_PERCENT + 1) * _LOG_STEP_PERCENT

        return report

    def export_timeline(
        self,
        request: ExportRequest,
        *,
        export_dir: str | Path,
        export_id: str | None = None,
        on_progress: ExportProgressCallback | None = None,
        cancel_event: threading.Event | None = None,
    ) -> ExportResult:
        """タイムラインの動画・画像・音声を1本の動画に合成し、テロップを焼き込む。

        黒背景（color）と無音（anullsrc）を、全クリップの終端までの長さで作る。
        .ass は exports に保存し、FFmpeg はそのフォルダでファイル名だけを参照する。
        on_progress は字幕作成が 0〜5、エンコードが 5〜100。完了時は 100 を返す。
        """
        started = time.monotonic()
        export_id = export_id or str(uuid.uuid4())
        if not re.fullmatch(r"[A-Za-z0-9_-]+", export_id):
            raise ValueError("export_id には英数字・ハイフン・アンダースコアだけを使ってください。")

        seg_list = validate_segments(request.segments)
        output_model = request.output
        exports = Path(export_dir).resolve()
        output_path = Path(output_model.path).resolve() if output_model.path else exports / f"{export_id}.mp4"
        if output_path.exists() and not output_model.overwrite:
            raise EngineError(
                "OUTPUT_EXISTS",
                "書き出し先に同じ名前のファイルがあります。",
                {"path": str(output_path)},
            )

        media = _load_timeline_media(request)
        ass_name = f"{export_id}.ass"
        graph = build_timeline_graph(request, media, ass_filename=ass_name)
        visible_count = sum(1 for seg in seg_list if seg.visible)
        logger.info(
            "タイムラインを合成します：映像 %d、音声 %d、%dx%d、%.3f 秒",
            sum(1 for clip in _visual_clips(request)),
            sum(1 for clip in _audio_clips(request) if media.get(clip.id) and media[clip.id].has_audio),
            request.width,
            request.height,
            graph.duration,
        )

        ass_start, ass_end, ass_status = _PROGRESS_ASS
        if on_progress:
            on_progress(ass_start, ass_status)
        exports.mkdir(parents=True, exist_ok=True)
        ass_path = exports / ass_name
        ass_path.write_text(
            build_ass(seg_list, request.style, request.width, request.height),
            encoding="utf-8-sig",
        )
        if on_progress:
            on_progress(ass_end, ass_status)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        partial_path = output_path.with_name(f"{output_path.stem}.partial{output_path.suffix}")
        encode_options = output_model
        if output_model.audio_codec == "copy":
            # ミックスした音声は元のストリームをそのままコピーできない
            encode_options = output_model.model_copy(update={"audio_codec": "aac"})
        try:
            run_ffmpeg(
                [
                    *graph.input_args,
                    *filter_complex_args(graph.filter_complex, exports / f"{export_id}.filter"),
                    "-map", "[vout]",
                    "-map", "[aout]",
                    "-t", _ff(graph.duration),
                    *_encode_args(encode_options),
                    str(partial_path),
                ],
                total_duration=graph.duration,
                on_progress=self._encode_progress(on_progress),
                cancel_event=cancel_event,
                cwd=exports,
            )
        except BaseException:
            partial_path.unlink(missing_ok=True)
            raise
        try:
            os.replace(partial_path, output_path)
        except OSError as e:
            partial_path.unlink(missing_ok=True)
            raise EngineError(
                "INTERNAL_ERROR",
                "書き出し先のファイルを置き換えられませんでした。ほかのアプリで開いていないか確認してください。",
                {"path": str(output_path), "reason": str(e)},
            ) from e

        # -progress の最終値に加え、書き出し完了の直前でも 100 を届ける
        if on_progress:
            on_progress(100.0, _PROGRESS_ENCODE[2])
        logger.info("タイムラインの合成が完了しました：%s（%.1f 秒）", output_path, time.monotonic() - started)
        return ExportResult(export_id, output_path, ass_path, visible_count, graph.duration)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="書き出しだけを単体で実行する（ステップ1〜3を実行済みのフォルダが必要。スタイルは既定値）"
    )
    parser.add_argument("work_dir", help="cut.mp4 と result.json があるフォルダ（例：../temp/test）")
    parser.add_argument("--threshold", type=int, default=1, choices=(1, 2, 3), help="この重要度以上の文だけを表示する")
    parser.add_argument("--variant", default="original", choices=("original", "summary", "impact"), help="表示する文言")
    parser.add_argument("--output", help="保存先（既定：<work_dir>/output.mp4。すでにあれば上書きする）")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    work = Path(args.work_dir)
    result_path = work / "result.json"
    if not result_path.is_file():
        raise SystemExit(f"{result_path} がありません。先にステップ3（python -m core.llm_processor）を実行してください。")
    analysis = json.loads(result_path.read_text(encoding="utf-8"))

    # UI の重要度スライダーと3択の選択を再現して、書き出しリクエストの segments を作る
    request_segments = [
        {
            "id": s["id"],
            "start": s["start"],
            "end": s["end"],
            "visible": s["importance"] >= args.threshold,
            "selected_variant": args.variant,
            "text": s["variants"][args.variant],
        }
        for s in analysis["segments"]
    ]
    output_path = Path(args.output) if args.output else work / "output.mp4"

    try:
        export = SubExporter().export(
            work / CUT_FILE,
            request_segments,
            SubtitleStyle(),
            OutputOptions(path=str(output_path), overwrite=True),
            export_dir=work / EXPORTS_DIR,
        )
    except EngineError as e:
        print(json.dumps(e.to_dict(), ensure_ascii=False, indent=2))
        raise SystemExit(1) from e

    print(f"\nテロップ {export.visible_count}/{len(request_segments)} 文を焼き込みました。")
    print(f"動画：{export.output_path}")
    print(f"字幕：{export.ass_path}")
