#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from pathlib import Path

env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

ARCHIVE_ROOT = Path(os.environ.get("SKOOL_ARCHIVE_ROOT", Path.cwd()))
COLLECTION_NAME = os.environ.get("SKOOL_COLLECTION_NAME", "Skool Community")
ROOT = ARCHIVE_ROOT / COLLECTION_NAME
QUALITY = os.environ.get("VIDEO_QUALITY", "720p").lower()
TARGET_WIDTH = 1280 if "720" in QUALITY else 1920
TARGET_HEIGHT = 720 if "720" in QUALITY else 1080


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
        "3500k",
        "-bufsize",
        "7000k",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        str(tmp),
    ]
    subprocess.run(cmd, check=True)
    tmp.replace(path)


def main():
    if not ROOT.exists():
        print(f"Directory {ROOT} does not exist", file=sys.stderr)
        return 1

    for path in ROOT.rglob("*.mp4"):
        if path.name.endswith(".optimized.mp4"):
            continue
        try:
            meta = probe(path)
            if should_transcode(meta):
                print(f"Optimizing {path.relative_to(ROOT)} to max {TARGET_WIDTH}x{TARGET_HEIGHT}...")
                transcode(path)
            else:
                print(f"Skipping {path.relative_to(ROOT)} (already optimal)")
        except Exception as e:
            print(f"Error checking {path}: {e}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main() or 0)
