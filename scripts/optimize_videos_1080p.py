#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from pathlib import Path

from skool_env import load_env, video_quality

load_env()

ARCHIVE_ROOT = Path(os.environ.get("SKOOL_ARCHIVE_ROOT", Path.cwd()))
COLLECTION_NAME = os.environ.get("SKOOL_COLLECTION_NAME", "Skool Community")
ROOT = ARCHIVE_ROOT / COLLECTION_NAME
# VIDEO_QUALITY=720p caps at 1280x720; 1080p (default) and best cap at 1920x1080.
QUALITY = video_quality()
if QUALITY == "720p":
    TARGET_WIDTH, TARGET_HEIGHT, MAXRATE, BUFSIZE = 1280, 720, "3500k", "7000k"
else:
    TARGET_WIDTH, TARGET_HEIGHT, MAXRATE, BUFSIZE = 1920, 1080, "5M", "10M"


def probe(path: Path) -> dict:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        str(path),
    ]
    out = subprocess.check_output(cmd, text=True)
    return json.loads(out)


def should_transcode(meta: dict) -> bool:
    video = next((s for s in meta["streams"] if s.get("codec_type") == "video"), None)
    if not video:
        return False
    width = int(video.get("width", 0) or 0)
    height = int(video.get("height", 0) or 0)
    size = int(float(meta["format"].get("size", 0) or 0))
    duration = float(meta["format"].get("duration", 0) or 0)
    if duration <= 0:
        return False
    mb_per_min = size / 1024 / 1024 / max(duration / 60, 1)
    return width > TARGET_WIDTH or height > TARGET_HEIGHT or mb_per_min > 14


def transcode(path: Path) -> None:
    tmp = path.with_name(path.stem + ".optimized.mp4")
    if tmp.exists():
        tmp.unlink()
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(path),
        "-vf",
        f"scale='min({TARGET_WIDTH},iw)':-2:flags=lanczos",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "22",
        "-maxrate",
        MAXRATE,
        "-bufsize",
        BUFSIZE,
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(tmp),
    ]
    try:
        subprocess.run(cmd, check=True)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    old_size = path.stat().st_size
    new_size = tmp.stat().st_size if tmp.exists() else 0
    if new_size <= 0 or new_size >= old_size:
        tmp.unlink(missing_ok=True)
        print(f"keep original {path.name}", flush=True)
        return
    tmp.replace(path)
    print(f"optimized {path.name}: {old_size} -> {new_size}", flush=True)


def main() -> int:
    if not ROOT.exists():
        print(f"Directory {ROOT} does not exist", file=sys.stderr)
        return 1

    failed = 0
    for path in sorted(ROOT.rglob("*.mp4")):
        if path.name.endswith(".optimized.mp4"):
            continue
        try:
            meta = probe(path)
            if should_transcode(meta):
                print(f"Optimizing {path.relative_to(ROOT)} to max {TARGET_WIDTH}x{TARGET_HEIGHT}...", flush=True)
                transcode(path)
            else:
                print(f"Skipping {path.relative_to(ROOT)} (already optimal)", flush=True)
        except Exception as e:
            failed += 1
            print(f"Error processing {path}: {e}", file=sys.stderr, flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
