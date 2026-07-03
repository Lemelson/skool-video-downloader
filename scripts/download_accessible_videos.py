#!/usr/bin/env python3
"""Batch-download the videos listed in a manifest into an organized folder tree.

The manifest is a JSON file (NOT bundled with this repo) that YOU create for the
course/community you have legitimate access to. See manifest.example.json for the
format. Each entry describes one video you can access and where it should be saved.

Usage:
    python3 download_accessible_videos.py [path/to/manifest.json]

Environment:
    SKOOL_MANIFEST         Path to the manifest JSON (default: ./manifest.json,
                           or the first CLI argument if given).
    SKOOL_ARCHIVE_ROOT     Root output folder (default: current directory).
    SKOOL_COLLECTION_NAME  Sub-folder name under the root (default: "Skool Community").
"""
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path


ROOT = Path(os.environ.get("SKOOL_ARCHIVE_ROOT", Path.cwd()))
COLLECTION_NAME = os.environ.get("SKOOL_COLLECTION_NAME", "Skool Community")
FINAL_ROOT = ROOT / COLLECTION_NAME


def log(msg: str) -> None:
    print(msg, flush=True)


def load_manifest() -> list:
    manifest_path = Path(
        sys.argv[1] if len(sys.argv) > 1 else os.environ.get("SKOOL_MANIFEST", "manifest.json")
    )
    if not manifest_path.exists():
        log(f"Manifest not found: {manifest_path}")
        log("Create one based on manifest.example.json describing the videos you can access.")
        raise SystemExit(2)
    with open(manifest_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, list):
        raise SystemExit("Manifest must be a JSON array of video entries.")
    return data


def safe_name(name: str) -> str:
    return name.replace("/", "-").replace(":", "꞉")


def target_path(item: dict) -> Path:
    section_dir = FINAL_ROOT / item.get("section", "")
    section_dir.mkdir(parents=True, exist_ok=True)
    if item.get("duration"):
        filename = f'{item["index"]:02d} - {safe_name(item["title"])} ({item["duration"]}).mp4'
    else:
        filename = f'{item["index"]:02d} - {safe_name(item["title"])}.mp4'
    return section_dir / filename


def is_valid_video(path: Path) -> bool:
    if not path.exists() or path.stat().st_size < 1024 * 1024:
        return False
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        return False
    try:
        return float(proc.stdout.strip()) > 60
    except ValueError:
        return False


def choose_wistia_asset(media_id: str) -> str:
    url = f"https://fast.wistia.com/embed/medias/{media_id}.json"
    with urllib.request.urlopen(url) as resp:
        obj = json.load(resp)
    assets = obj["media"]["assets"]
    candidates = []
    for asset in assets:
        if asset.get("status") != 2:
            continue
        if asset.get("type") not in {"hd_mp4_video", "md_mp4_video", "mp4_video", "iphone_video", "original"}:
            continue
        asset_url = asset.get("url")
        if not asset_url:
            continue
        display = (asset.get("display_name") or "").lower()
        width = asset.get("width") or 0
        height = asset.get("height") or 0
        size = asset.get("size") or 0
        score = 0
        if display == "1080p":
            score = 500
        elif display == "4k":
            score = 450
        elif display == "720p":
            score = 300
        elif asset.get("type") == "hd_mp4_video":
            score = 250
        elif asset.get("type") == "md_mp4_video":
            score = 200
        elif asset.get("type") == "mp4_video":
            score = 150
        elif asset.get("type") == "iphone_video":
            score = 100
        elif asset.get("type") == "original":
            score = 10
        candidates.append((score, width * height, -size, asset_url))
    if not candidates:
        raise RuntimeError(f"No downloadable mp4 asset found for Wistia id {media_id}")
    candidates.sort(reverse=True)
    return candidates[0][3]


def download_file(url: str, dest: Path) -> None:
    tmp = dest.with_suffix(dest.suffix + ".part")
    if tmp.exists():
        tmp.unlink()
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp, open(tmp, "wb") as fh:
        shutil.copyfileobj(resp, fh, length=1024 * 1024)
    tmp.replace(dest)


def download_youtube(url: str, dest: Path) -> None:
    tmp_template = str(dest.with_suffix(".%(ext)s"))
    cmd = [
        os.environ.get("YTDLP", "yt-dlp"),
        "--no-playlist",
        "--merge-output-format",
        "mp4",
        "-f",
        "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
        "-o",
        tmp_template,
        url,
    ]
    subprocess.run(cmd, check=True)
    if not dest.exists():
        alt = dest.with_suffix(".mkv")
        if alt.exists():
            alt.replace(dest)


def remove_partial_files() -> None:
    for part in FINAL_ROOT.rglob("*.part"):
        log(f"remove partial {part}")
        part.unlink()


def main() -> int:
    manifest = load_manifest()
    FINAL_ROOT.mkdir(parents=True, exist_ok=True)
    remove_partial_files()

    for item in manifest:
        dest = target_path(item)
        if is_valid_video(dest):
            log(f"skip ok {dest.name}")
            continue
        if dest.exists():
            log(f"remove broken {dest}")
            dest.unlink()
        log(f"download {dest.name}")
        if item["kind"] == "wistia":
            asset_url = choose_wistia_asset(item["id"])
            download_file(asset_url, dest)
        elif item["kind"] == "youtube":
            download_youtube(item["url"], dest)
        else:
            raise RuntimeError(f"Unknown kind: {item['kind']}")
        if not is_valid_video(dest):
            raise RuntimeError(f"Downloaded file failed verification: {dest}")
        log(f"verified {dest.name}")

    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
