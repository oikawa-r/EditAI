"""FFmpeg / ffprobe の呼び出しをまとめたモジュール（ステップ1と5で使う）。"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import wave
from collections import deque
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Callable, Sequence

import numpy as np

from .errors import CancelledByUser, EngineError

FFMPEG = os.environ.get("EDITAI_FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("EDITAI_FFPROBE", "ffprobe")

# Silero VAD と Whisper はどちらも 16kHz・モノラルの音声を前提にしている
SAMPLE_RATE = 16_000

# デスクトップアプリから起動したとき、FFmpeg を呼ぶたびにコンソール画面が開かないようにする
_CREATIONFLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

# Windows のコマンドラインは約 32,000 文字までなので、これより長いフィルターはファイルで渡す
_INLINE_FILTER_LIMIT = 8000

# 進捗の割合（0.0〜1.0）を受け取る関数
RatioCallback = Callable[[float], None]


@dataclass(frozen=True)
class MediaInfo:
    duration: float
    width: int
    height: int
    fps: float
    has_audio: bool


def _not_found(command: str) -> EngineError:
    return EngineError(
        "FFMPEG_ERROR",
        f"{command} が見つかりません。FFmpeg をインストールし、PATH を通してください。",
        {"command": command},
    )


def _run(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            list(args),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=_CREATIONFLAGS,
        )
    except FileNotFoundError as e:
        raise _not_found(args[0]) from e


def _parse_rate(rate: str | None) -> float:
    """ffprobe のフレームレート（"30000/1001" など）を float にする。"""
    if not rate:
        return 0.0
    num, _, den = rate.partition("/")
    try:
        n = float(num)
        d = float(den) if den else 1.0
    except ValueError:
        return 0.0
    return n / d if d else 0.0


def probe(path: Path) -> MediaInfo:
    result = _run([
        FFPROBE, "-v", "error",
        "-show_entries", "format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate",
        "-of", "json",
        str(path),
    ])
    if result.returncode != 0:
        raise EngineError(
            "UNSUPPORTED_FORMAT",
            "動画ファイルを読み込めませんでした。",
            {"path": str(path), "stderr": result.stderr.strip()[-2000:]},
        )

    data = json.loads(result.stdout or "{}")
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    try:
        duration = float(data.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        duration = 0.0

    if video is None or duration <= 0:
        raise EngineError(
            "UNSUPPORTED_FORMAT",
            "映像が含まれていないか、長さを取得できない動画です。",
            {"path": str(path)},
        )

    return MediaInfo(
        duration=duration,
        width=int(video.get("width", 0)),
        height=int(video.get("height", 0)),
        fps=_parse_rate(video.get("avg_frame_rate")) or _parse_rate(video.get("r_frame_rate")),
        has_audio=has_audio,
    )


@dataclass(frozen=True)
class StreamInfo:
    """ファイルに映像・音声があるかと、最初の映像の幅・高さ。"""

    has_video: bool
    has_audio: bool
    width: int
    height: int


def probe_streams(path: Path) -> StreamInfo:
    """映像と音声の有無、映像の解像度を返す。画像や音声だけのファイルでも失敗しない。"""
    result = _run([
        FFPROBE, "-v", "error",
        "-show_entries", "stream=codec_type,width,height",
        "-of", "json",
        str(path),
    ])
    if result.returncode != 0:
        raise EngineError(
            "UNSUPPORTED_FORMAT",
            "素材ファイルを読み込めませんでした。",
            {"path": str(path), "stderr": result.stderr.strip()[-2000:]},
        )
    try:
        streams = json.loads(result.stdout or "{}").get("streams", [])
    except json.JSONDecodeError as e:
        raise EngineError(
            "UNSUPPORTED_FORMAT",
            "素材ファイルを読み込めませんでした。",
            {"path": str(path)},
        ) from e
    has_video = False
    has_audio = False
    width = 0
    height = 0
    for item in streams:
        kind = item.get("codec_type")
        if kind == "audio":
            has_audio = True
        elif kind == "video":
            has_video = True
            if width <= 0:
                try:
                    width = int(item.get("width") or 0)
                    height = int(item.get("height") or 0)
                except (TypeError, ValueError):
                    width = 0
                    height = 0
    return StreamInfo(has_video, has_audio, width, height)


@lru_cache(maxsize=1)
def ffmpeg_filter_names() -> frozenset[str]:
    """この FFmpeg が持っているフィルター名。無い環境では空。"""
    try:
        result = _run([FFMPEG, "-hide_banner", "-filters"])
    except EngineError:
        return frozenset()
    names: set[str] = set()
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 3 and "->" in parts[2]:
            names.add(parts[1])
    return frozenset(names)


def ffmpeg_version() -> str | None:
    """FFmpeg のバージョン文字列（"7.1-full_build-www.gyan.dev" など）。見つからなければ None。"""
    try:
        result = _run([FFMPEG, "-version"])
    except EngineError:
        return None
    match = re.match(r"ffmpeg version (\S+)", result.stdout)
    return match.group(1) if match else None


@lru_cache(maxsize=1)
def ffmpeg_major_version() -> int | None:
    """FFmpeg のメジャーバージョン。開発版（"N-12345-g..." など）で読めないときは None。"""
    result = _run([FFMPEG, "-version"])
    match = re.match(r"ffmpeg version n?(\d+)\.", result.stdout)
    return int(match.group(1)) if match else None


def filter_complex_args(graph: str, script_path: Path) -> list[str]:
    """-filter_complex の引数を作る。長いときは script_path に書き出してファイルで渡す。"""
    if len(graph) <= _INLINE_FILTER_LIMIT:
        return ["-filter_complex", graph]

    script_path.write_text(graph, encoding="utf-8")
    major = ffmpeg_major_version()
    # -filter_complex_script は FFmpeg 7.1 で非推奨になり、新しい版では -/filter_complex を使う
    if major is not None and major <= 7:
        return ["-filter_complex_script", str(script_path)]
    return ["-/filter_complex", str(script_path)]


def run_ffmpeg(
    args: Sequence[str],
    *,
    total_duration: float | None = None,
    on_progress: RatioCallback | None = None,
    cancel_event: threading.Event | None = None,
    cwd: Path | None = None,
) -> None:
    """FFmpeg を実行する。

    total_duration（出力の長さ・秒）を渡すと、-progress の出力から進捗の割合を on_progress に返す。
    cancel_event がセットされたら FFmpeg を止めて CancelledByUser を送出する。
    cwd は FFmpeg を起動するフォルダ（フィルターに相対パスでファイルを渡すときに使う）。
    """
    command = [
        FFMPEG, "-hide_banner", "-nostdin", "-y",
        "-loglevel", "error", "-nostats", "-progress", "pipe:1",
        *args,
    ]
    try:
        proc = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=_CREATIONFLAGS,
            cwd=cwd,
        )
    except FileNotFoundError as e:
        raise _not_found(FFMPEG) from e

    # stderr を別スレッドで読み続けないと、パイプが詰まって FFmpeg が止まることがある
    stderr_tail: deque[str] = deque(maxlen=50)
    reader = threading.Thread(target=stderr_tail.extend, args=(proc.stderr,), daemon=True)
    reader.start()

    try:
        # -progress は約 0.5 秒ごとに出力されるので、そのたびに中断を確認する
        for line in proc.stdout:
            if cancel_event is not None and cancel_event.is_set():
                raise CancelledByUser()
            key, _, value = line.strip().partition("=")
            if key == "out_time_us" and on_progress and total_duration:
                try:
                    seconds = int(value) / 1_000_000
                except ValueError:
                    continue
                on_progress(min(max(seconds / total_duration, 0.0), 1.0))
        proc.wait()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        reader.join(timeout=5)

    if proc.returncode != 0:
        raise EngineError(
            "FFMPEG_ERROR",
            "FFmpeg の実行に失敗しました。",
            {"returncode": proc.returncode, "stderr": "".join(stderr_tail).strip()},
        )
    if on_progress:
        on_progress(1.0)


def extract_audio(
    source: Path,
    audio_path: Path,
    *,
    duration: float,
    on_progress: RatioCallback | None = None,
    cancel_event: threading.Event | None = None,
) -> None:
    """VAD・Whisper 用に、16kHz・モノラル・16bit PCM の wav を作る。"""
    run_ffmpeg(
        ["-i", str(source), "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(audio_path)],
        total_duration=duration,
        on_progress=on_progress,
        cancel_event=cancel_event,
    )


def read_wav(path: Path) -> np.ndarray:
    """extract_audio で作った wav を -1.0〜1.0 の float32 配列にする。"""
    with wave.open(str(path), "rb") as wav:
        frames = wav.readframes(wav.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
