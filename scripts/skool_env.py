"""Shared helpers for the Python scripts: .env loading and VIDEO_QUALITY parsing."""
import os
import sys
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
VIDEO_QUALITIES = ("720p", "1080p", "best")
DEFAULT_VIDEO_QUALITY = "1080p"


def load_env(path: Path = ENV_PATH) -> None:
    """Load KEY=VALUE lines from the project-root .env without overriding the real environment.

    Empty values are ignored (so `YTDLP=` falls back to the default), surrounding quotes are
    stripped, and ~ / $HOME are expanded.
    """
    if not path.exists():
        return
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line.startswith("export "):
                line = line[len("export "):].lstrip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if not value or os.environ.get(key):
                continue
            os.environ[key] = os.path.expanduser(os.path.expandvars(value))


def video_quality() -> str:
    """Return the normalized VIDEO_QUALITY: one of 720p, 1080p, best (default 1080p)."""
    raw = os.environ.get("VIDEO_QUALITY", "").strip().lower()
    if not raw:
        return DEFAULT_VIDEO_QUALITY
    if raw in ("720", "720p"):
        return "720p"
    if raw in ("1080", "1080p"):
        return "1080p"
    if raw in ("best", "max"):
        return "best"
    print(
        f"Unknown VIDEO_QUALITY={raw!r}; expected one of {', '.join(VIDEO_QUALITIES)}. "
        f"Using {DEFAULT_VIDEO_QUALITY}.",
        file=sys.stderr,
    )
    return DEFAULT_VIDEO_QUALITY
