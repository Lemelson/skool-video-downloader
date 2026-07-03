#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from pathlib import Path


ARCHIVE_ROOT = Path(os.environ.get("SKOOL_ARCHIVE_ROOT", Path.cwd()))
COLLECTION_NAME = os.environ.get("SKOOL_COLLECTION_NAME", "Skool Community")
ROOT = ARCHIVE_ROOT / COLLECTION_NAME


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
    return width > 1920 or height > 1080 or mb_per_min > 14


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
        "scale='min(1920,iw)':-2:flags=lanczos",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "22",
        "-maxrate",
        "5M",
        "-bufsize",
        "10M",
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
    subprocess.run(cmd, check=True)
    new_meta = probe(tmp)
    old_size = path.stat().st_size
    new_size = tmp.stat().st_size
    if new_size <= 0 or new_size >= old_size:
        tmp.unlink(missing_ok=True)
        print(f"keep original {path.name}", flush=True)
        return
    tmp.replace(path)
    print(f"optimized {path.name}: {old_size} -> {new_size}", flush=True)


def main() -> int:
    files = sorted(ROOT.rglob("*.mp4"))
    for path in files:
        meta = probe(path)
        if should_transcode(meta):
            print(f"transcode {path}", flush=True)
            transcode(path)
        else:
            print(f"skip {path.name}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
