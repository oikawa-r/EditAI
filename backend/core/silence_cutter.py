"""ステップ1：無音カット。

元動画から音声を抽出し、Silero VAD で発話区間を検出して、発話部分だけをつなげた cut.mp4 を作る。
仕様は docs/02_silence_cut.md を参照。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable

import numpy as np

from .errors import CancelledByUser, EngineError
from .media import (
    SAMPLE_RATE,
    MediaInfo,
    RatioCallback,
    extract_audio,
    filter_complex_args,
    probe,
    read_wav,
    run_ffmpeg,
)

SUPPORTED_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".webm"}

# これより短い発話は、咳や物音とみなして捨てる（Silero VAD の標準値）
MIN_SPEECH_MS = 250

AUDIO_FILE = "audio.wav"
CUT_FILE = "cut.mp4"
RESULT_FILE = "silence_cut.json"
FILTER_SCRIPT_FILE = "cut_filter.txt"

# 進捗（0〜100）のうち、各工程が占める範囲
_PROGRESS_EXTRACT = (0.0, 10.0)
_PROGRESS_VAD = (10.0, 25.0)
_PROGRESS_ENCODE = (25.0, 100.0)

# cut.mp4 はプレビュー再生と書き出しの元になるので、画質を優先する
_ENCODE_ARGS = [
    "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
]

ProgressCallback = Callable[[float], None]


@dataclass(frozen=True)
class SilenceOptions:
    """POST /projects の options.silence。"""

    enabled: bool = True
    vad_threshold: float = 0.5
    min_silence_ms: int = 500
    padding_ms: int = 150

    def __post_init__(self) -> None:
        if not 0.0 <= self.vad_threshold <= 1.0:
            raise ValueError("vad_threshold は 0.0〜1.0 で指定してください。")
        if self.min_silence_ms < 0 or self.padding_ms < 0:
            raise ValueError("min_silence_ms と padding_ms は 0 以上で指定してください。")

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> SilenceOptions:
        data = data or {}
        keys = ("enabled", "vad_threshold", "min_silence_ms", "padding_ms")
        return cls(**{key: data[key] for key in keys if key in data})


@dataclass(frozen=True)
class KeptRange:
    """残した区間。source_* は元動画、output_* はカット後の動画の時間（秒）。"""

    source_start: float
    source_end: float
    output_start: float
    output_end: float

    def to_dict(self) -> dict[str, float]:
        return {key: round(value, 3) for key, value in asdict(self).items()}


@dataclass(frozen=True)
class SilenceCutResult:
    enabled: bool
    media: MediaInfo
    kept_ranges: tuple[KeptRange, ...]
    cut_path: Path
    audio_path: Path

    @property
    def original_duration(self) -> float:
        return self.media.duration

    @property
    def cut_duration(self) -> float:
        return self.kept_ranges[-1].output_end

    @property
    def removed_duration(self) -> float:
        return self.original_duration - self.cut_duration

    def to_dict(self) -> dict[str, Any]:
        """GET /projects/{id}/result の silence_cut と同じ形。"""
        return {
            "enabled": self.enabled,
            "original_duration": round(self.original_duration, 3),
            "cut_duration": round(self.cut_duration, 3),
            "removed_duration": round(self.removed_duration, 3),
            "kept_ranges": [r.to_dict() for r in self.kept_ranges],
        }


# ---------- 区間の計算（FFmpeg を使わない部分） ----------

def build_kept_ranges(
    speech: list[tuple[float, float]],
    duration: float,
    padding: float,
    fps: float = 0.0,
) -> list[KeptRange]:
    """発話区間に余白を足し、重なりを結合して、残す区間の対応表を作る。

    fps を渡すと区間の境目をフレームの境目にそろえる。映像はフレーム単位でしか切れないため、
    そろえないと区間ごとに誤差が出て、カット後の時間がだんだんずれていく。
    """
    padded: list[list[float]] = []
    for start, end in sorted(speech):
        s = max(0.0, start - padding)
        e = min(duration, end + padding)
        if fps > 0:
            s = round(s * fps) / fps
            e = min(duration, round(e * fps) / fps)
        if e > s:
            padded.append([s, e])

    merged: list[list[float]] = []
    for s, e in padded:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])

    ranges: list[KeptRange] = []
    output = 0.0
    for s, e in merged:
        length = e - s
        ranges.append(KeptRange(s, e, output, output + length))
        output += length
    return ranges


def build_filter_graph(ranges: list[KeptRange], fps: float) -> str:
    """区間ごとに trim / atrim で切り出し、concat でつなげるフィルターを作る。"""
    # フレームの時刻がちょうど境目に来たとき、小数の誤差で前後のフレームが入ったり抜けたりしないよう、
    # 映像の切り出し位置を半フレーム前にずらす
    half_frame = 0.5 / fps if fps > 0 else 0.0
    parts: list[str] = []
    pads: list[str] = []
    for i, r in enumerate(ranges):
        v_start = max(0.0, r.source_start - half_frame)
        v_end = r.source_end - half_frame
        parts.append(f"[0:v:0]trim=start={v_start:.6f}:end={v_end:.6f},setpts=PTS-STARTPTS[v{i}]")
        parts.append(
            f"[0:a:0]atrim=start={r.source_start:.6f}:end={r.source_end:.6f},asetpts=PTS-STARTPTS[a{i}]"
        )
        pads.append(f"[v{i}][a{i}]")
    parts.append(f"{''.join(pads)}concat=n={len(ranges)}:v=1:a=1[outv][outa]")
    return ";".join(parts)


# ---------- 各工程 ----------

def _check_cancel(cancel_event: threading.Event | None) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise CancelledByUser()


def _stage(on_progress: ProgressCallback | None, span: tuple[float, float]) -> RatioCallback | None:
    """工程内の割合（0.0〜1.0）を、全体の進捗（0〜100）に変換して返す関数を作る。"""
    if on_progress is None:
        return None
    start, end = span
    return lambda ratio: on_progress(start + (end - start) * ratio)


def validate_source(source: Path) -> None:
    """元動画が存在し、対応している拡張子か確認する（API で受け付ける前にも使う）。"""
    if not source.is_file():
        raise EngineError("FILE_NOT_FOUND", "指定された動画ファイルが見つかりません。", {"path": str(source)})
    if source.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise EngineError(
            "UNSUPPORTED_FORMAT",
            "対応していない動画形式です。",
            {"path": str(source), "supported": sorted(SUPPORTED_EXTENSIONS)},
        )


def detect_speech(audio: np.ndarray, options: SilenceOptions) -> list[tuple[float, float]]:
    """Silero VAD で発話区間（秒）を検出する。余白はここでは足さない。"""
    try:
        from faster_whisper.vad import VadOptions, get_speech_timestamps
    except ImportError as e:
        raise EngineError(
            "INTERNAL_ERROR",
            "faster-whisper が見つかりません。backend/requirements.txt のライブラリをインストールしてください。",
        ) from e

    vad_options = VadOptions(
        threshold=options.vad_threshold,
        min_speech_duration_ms=MIN_SPEECH_MS,
        min_silence_duration_ms=options.min_silence_ms,
        speech_pad_ms=0,
    )
    timestamps = get_speech_timestamps(audio, vad_options)
    return [(t["start"] / SAMPLE_RATE, t["end"] / SAMPLE_RATE) for t in timestamps]


def _encode_cut(
    source: Path,
    work_dir: Path,
    ranges: list[KeptRange],
    media: MediaInfo,
    on_progress: ProgressCallback | None,
    cancel_event: threading.Event | None,
) -> Path:
    cut_path = work_dir / CUT_FILE
    # 途中で失敗・中断しても壊れた cut.mp4 が残らないよう、別名で書いてから名前を変える
    partial_path = work_dir / "cut.partial.mp4"
    graph = build_filter_graph(ranges, media.fps)
    try:
        run_ffmpeg(
            [
                "-i", str(source),
                *filter_complex_args(graph, work_dir / FILTER_SCRIPT_FILE),
                "-map", "[outv]", "-map", "[outa]",
                *_ENCODE_ARGS,
                str(partial_path),
            ],
            total_duration=ranges[-1].output_end,
            on_progress=_stage(on_progress, _PROGRESS_ENCODE),
            cancel_event=cancel_event,
        )
    except BaseException:
        partial_path.unlink(missing_ok=True)
        raise
    os.replace(partial_path, cut_path)
    return cut_path


def _save_result(work_dir: Path, source: Path, options: SilenceOptions, result: SilenceCutResult) -> None:
    data = {
        "source_path": source.as_posix(),
        "options": asdict(options),
        "media": asdict(result.media),
        **result.to_dict(),
    }
    (work_dir / RESULT_FILE).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------- 入口 ----------

def stage_without_cut(source_path: str | Path, work_dir: str | Path) -> SilenceCutResult:
    """無音検出をせず、元動画をそのまま文字起こしの入力にする。

    cut.mp4 は元ファイルへのリンク（失敗したときはコピー）にし、動画全体を残す区間だけを記録する。
    """
    source = Path(source_path)
    work = Path(work_dir)
    validate_source(source)
    media = probe(source)
    work.mkdir(parents=True, exist_ok=True)
    cut_path = work / "cut.mp4"
    if not cut_path.exists():
        try:
            os.link(source, cut_path)
        except OSError:
            shutil.copy2(source, cut_path)
    duration = max(media.duration, 0.0)
    result = SilenceCutResult(
        enabled=False,
        media=media,
        kept_ranges=(KeptRange(0.0, duration, 0.0, duration),),
        cut_path=cut_path,
        audio_path=work / AUDIO_FILE,
    )
    _save_result(work, source, SilenceOptions(enabled=False), result)
    return result


def cut_silence(
    source_path: str | Path,
    work_dir: str | Path,
    options: SilenceOptions | None = None,
    *,
    on_progress: ProgressCallback | None = None,
    cancel_event: threading.Event | None = None,
) -> SilenceCutResult:
    """無音カットを行い、work_dir に audio.wav / cut.mp4 / silence_cut.json を作る。

    on_progress には進捗（0〜100）を渡す。cancel_event がセットされると CancelledByUser を送出する。
    """
    options = options or SilenceOptions()
    source = Path(source_path)
    work = Path(work_dir)

    validate_source(source)
    media = probe(source)
    if not media.has_audio:
        raise EngineError(
            "UNSUPPORTED_FORMAT",
            "音声が含まれていない動画です。無音カットと文字起こしには音声が必要です。",
            {"path": str(source)},
        )
    work.mkdir(parents=True, exist_ok=True)

    audio_path = work / AUDIO_FILE
    _check_cancel(cancel_event)
    extract_audio(
        source,
        audio_path,
        duration=media.duration,
        on_progress=_stage(on_progress, _PROGRESS_EXTRACT),
        cancel_event=cancel_event,
    )

    speech: list[tuple[float, float]] = []
    if options.enabled:
        _check_cancel(cancel_event)
        speech = detect_speech(read_wav(audio_path), options)
    if on_progress:
        on_progress(_PROGRESS_VAD[1])

    ranges = build_kept_ranges(speech, media.duration, options.padding_ms / 1000, media.fps)
    if not ranges:
        # 無音カットをしない場合と、発話が見つからなかった場合は、動画全体を残す（処理は止めない）
        ranges = build_kept_ranges([(0.0, media.duration)], media.duration, 0.0)

    _check_cancel(cancel_event)
    cut_path = _encode_cut(source, work, ranges, media, on_progress, cancel_event)

    result = SilenceCutResult(
        enabled=options.enabled,
        media=media,
        kept_ranges=tuple(ranges),
        cut_path=cut_path,
        audio_path=audio_path,
    )
    _save_result(work, source, options, result)
    return result


def _main() -> None:
    parser = argparse.ArgumentParser(description="無音カットだけを単体で実行する")
    parser.add_argument("source", help="元動画のパス")
    parser.add_argument("work_dir", help="出力先のフォルダ（例：../temp/test）")
    parser.add_argument("--threshold", type=float, default=0.5, help="VAD のしきい値（0.0〜1.0）")
    parser.add_argument("--min-silence-ms", type=int, default=500, help="この長さ以上の無音をカットする")
    parser.add_argument("--padding-ms", type=int, default=150, help="発話の前後に残す余白")
    parser.add_argument("--no-cut", action="store_true", help="無音カットをせず、動画全体を cut.mp4 にする")
    args = parser.parse_args()

    options = SilenceOptions(
        enabled=not args.no_cut,
        vad_threshold=args.threshold,
        min_silence_ms=args.min_silence_ms,
        padding_ms=args.padding_ms,
    )
    try:
        result = cut_silence(
            args.source,
            args.work_dir,
            options,
            on_progress=lambda p: print(f"\r進捗 {p:5.1f}%", end="", flush=True),
        )
    except EngineError as e:
        print()
        print(json.dumps(e.to_dict(), ensure_ascii=False, indent=2))
        raise SystemExit(1) from e

    print()
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    print(f"出力：{result.cut_path}")


if __name__ == "__main__":
    _main()
