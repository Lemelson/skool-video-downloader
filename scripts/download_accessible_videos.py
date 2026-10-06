#!/usr/bin/env python3
"""Batch-download the videos listed in a manifest or course-state file into an organized folder tree.

Usage:
    python3 download_accessible_videos.py [path/to/manifest.json | path/to/course-state.json]

Environment:
    SKOOL_MANIFEST         Path to the manifest JSON (default: auto-detects manifest.json, course-state.json, or lesson-details.json).
    SKOOL_ARCHIVE_ROOT     Root output folder (default: current directory or from .env).
    SKOOL_COLLECTION_NAME  Sub-folder name under the root (default: "Skool Community" or "Skool").
    VIDEO_QUALITY          Video quality preference (720p, 1080p, best).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

ROOT = Path(os.environ.get("SKOOL_ARCHIVE_ROOT", Path.cwd()))
COLLECTION_NAME = os.environ.get("SKOOL_COLLECTION_NAME", "Skool Community")
FINAL_ROOT = ROOT / COLLECTION_NAME


def log(msg: str) -> None:
    print(msg, flush=True)


def convert_state_to_manifest(data: list, found_path: Path = None) -> list:
    items = []
    idx = 1

    inferred_course_title = ""
    if found_path:
        try:
            if FINAL_ROOT in found_path.parents:
                rel = found_path.relative_to(FINAL_ROOT)
                if len(rel.parts) > 1:
                    inferred_course_title = rel.parts[0]
            elif ROOT in found_path.parents:
                rel = found_path.relative_to(ROOT)
                if len(rel.parts) > 1:
                    inferred_course_title = rel.parts[0]
        except Exception:
            pass

    current_course_title = inferred_course_title

    for row in data:
        if not isinstance(row, dict):
            continue

        if row.get("type") == "course" or "numModules" in row:
            title = row.get("title") or row.get("courseTitle") or row.get("course_title")
            if title:
                current_course_title = title

        vlink = row.get("videoLink") or row.get("video_url")
        if not vlink and "resources" in row:
            for r in row.get("resources", []):
                link = r.get("link", "")
                if link and any(k in link for k in ("wistia", "youtube", "youtu.be", "loom.com", "vimeo")):
                    vlink = link
                    break

        if not vlink:
            continue

        course_title = row.get("courseTitle") or row.get("course_title") or current_course_title or "Course Material"
        section = row.get("section") or ""
        title = row.get("title") or row.get("moduleTitle") or f"Lesson {idx}"
        duration = ""
        if row.get("videoLenMs"):
            mins = int(row["videoLenMs"]) // 60000
            secs = (int(row["videoLenMs"]) % 60000) // 1000
            duration = f"{mins}:{secs:02d}"

        kind = "url"
        v_id = None
        if "wistia.com/medias/" in vlink:
            kind = "wistia"
            v_id = vlink.split("wistia.com/medias/")[1].split("?")[0].split("/")[0]
        elif "wistia.com" in vlink or "wistia.net" in vlink:
            kind = "wistia"
            v_id = vlink.rstrip("/").split("/")[-1].split("?")[0]

        item = {
            "index": idx,
            "courseTitle": course_title,
            "section": section,
            "title": title,
            "duration": duration,
            "kind": kind,
            "url": vlink,
        }
        if v_id:
            item["id"] = v_id
        items.append(item)
        idx += 1
    return items


def load_manifest() -> list:
    arg = sys.argv[1] if len(sys.argv) > 1 else None

    if arg and (arg.startswith("http://") or arg.startswith("https://")):
        log(f"[INFO] URL provided ({arg}).")
        log("[INFO] Videos are downloaded based on state files (course-state.json / lesson-details.json).")
        log("[INFO] Searching for generated state file in output directory...")
        arg = None

    candidate_paths = []
    if arg:
        candidate_paths.append(Path(arg))
    
    env_manifest = os.environ.get("SKOOL_MANIFEST")
    if env_manifest:
        candidate_paths.append(Path(env_manifest))

    # Sort nested state files by modification time (mtime) descending.
    # Prioritize course-state.json over lesson-details.json because course-state.json contains the direct videoLinks.
    course_state_files = sorted(list(FINAL_ROOT.rglob("course-state.json")), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    lesson_detail_files = sorted(list(FINAL_ROOT.rglob("lesson-details.json")), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    
    for sub in course_state_files + lesson_detail_files:
        candidate_paths.append(sub)

    candidate_names = ["course-state.json", "lesson-details.json", "manifest.json"]
    for name in candidate_names:
        candidate_paths.append(FINAL_ROOT / name)
        candidate_paths.append(ROOT / name)
        candidate_paths.append(Path.cwd() / name)

    found_path = None
    for p in candidate_paths:
        if p.exists() and p.is_file():
            found_path = p
            break

    if not found_path:
        log("[ERROR] Manifest or course state file not found (course-state.json / lesson-details.json).")
        log("[TIP] Run `npm run course:state <URL>` first to generate the course state file.")
        raise SystemExit(2)

    log(f"[INFO] Loading video data from: {found_path}")
    with open(found_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    if not isinstance(data, list):
        raise SystemExit("Manifest or state file must be a JSON array.")

    # Check if this is a course-state/lesson-details array needing conversion
    if data and isinstance(data[0], dict) and ("type" in data[0] or "videoLink" in data[0] or "moduleId" in data[0]):
        manifest = convert_state_to_manifest(data, found_path=found_path)
        if not manifest:
            log("[WARNING] Course state file does not contain direct video links for these lessons.")
        return manifest

    return data


def safe_name(name: str) -> str:
    return name.replace("/", "-").replace(":", "꞉").strip()


def target_path(item: dict) -> Path:
    raw_course = item.get("courseTitle", "").strip() or "Course Material"
    course_title = safe_name(raw_course)
    section_name = safe_name(item.get("section", ""))

    if course_title and section_name and section_name != course_title:
        section_dir = FINAL_ROOT / course_title / section_name
    else:
        section_dir = FINAL_ROOT / course_title

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
        return float(proc.stdout.strip()) > 10
    except ValueError:
        return False


def choose_wistia_asset(media_id: str) -> str:
    url = f"https://fast.wistia.com/embed/medias/{media_id}.json"
    with urllib.request.urlopen(url) as resp:
        obj = json.load(resp)
    assets = obj["media"]["assets"]
    candidates = []
    target_quality = os.environ.get("VIDEO_QUALITY", "720p").lower()
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
        if target_quality in display:
            score = 1000
        elif display == "720p":
            score = 300
        elif display == "1080p":
            score = 250
        elif display == "4k":
            score = 200
        elif asset.get("type") == "hd_mp4_video":
            score = 150
        elif asset.get("type") == "md_mp4_video":
            score = 100
        else:
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
    quality = os.environ.get("VIDEO_QUALITY", "720p").lower()
    if "720" in quality:
        fmt = "bv*[height<=720]+ba/b[height<=720]/b"
    elif "1080" in quality:
        fmt = "bv*[height<=1080]+ba/b[height<=1080]/b"
    else:
        fmt = "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b"

    cmd = [
        os.environ.get("YTDLP", "yt-dlp"),
        "--no-playlist",
        "--merge-output-format",
        "mp4",
        "-f",
        fmt,
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

    log(f"[INFO] Found {len(manifest)} video(s) to process.")
    for item in manifest:
        dest = target_path(item)
        if is_valid_video(dest):
            log(f"[SKIP] Already downloaded and verified: {dest.name}")
            continue
        if dest.exists():
            log(f"[RETRY] Removed corrupted file: {dest}")
            dest.unlink()
        log(f"[DOWNLOADING] {dest.name}...")
        if item["kind"] == "wistia":
            asset_url = choose_wistia_asset(item["id"])
            download_file(asset_url, dest)
        else:
            download_youtube(item["url"], dest)

        if not is_valid_video(dest):
            log(f"[WARNING] Video file verification failed: {dest}")
        else:
            log(f"[OK] Successfully downloaded: {dest.name}")

    log("[SUCCESS] Video download process completed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
