#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse, urlunparse


from skool_env import load_env, video_quality

load_env()

YTDLP = os.environ.get("YTDLP") or "yt-dlp"


def run(cmd):
    subprocess.run(cmd, check=True)


def extract(video_url):
    cmd = [
        YTDLP,
        "--extractor-args",
        "youtube:player_client=mweb",
        "-j",
        video_url,
    ]
    out = subprocess.check_output(cmd, text=True)
    return json.loads(out)


def pick(formats, ids):
    by_id = {f.get("format_id"): f for f in formats}
    for fmt_id in ids:
        if fmt_id in by_id and by_id[fmt_id].get("url"):
            return by_id[fmt_id]

    # YouTube sometimes exposes localized audio as 140-0, 140-1, ...
    # Prefer the original/default English track when present, then any prefix match.
    for fmt_id in ids:
        matches = [
            f for f in formats
            if (f.get("format_id") or "").startswith(fmt_id + "-") and f.get("url")
        ]
        if not matches:
            continue
        preferred = sorted(
            matches,
            key=lambda f: (
                "original" not in (f.get("format_note") or "").lower()
                and not f.get("language", "").startswith("en"),
                not f.get("language", "").startswith("en"),
                f.get("format_id") or "",
            ),
        )
        return preferred[0]
    raise RuntimeError(f"No matching format found: {ids}")


def host_candidates(url):
    parsed = urlparse(url)
    qs = parse_qs(parsed.query)
    current = parsed.netloc
    hosts = []
    prefix = current.split("---", 1)[0] + "---" if "---" in current else "rr2---"
    mn_values = [mn for mn in qs.get("mn", [""])[0].split(",") if mn]
    for mn in mn_values[1:] + mn_values[:1]:
        hosts.append(f"rr2---{mn}.googlevideo.com")
        hosts.append(f"rr5---{mn}.googlevideo.com")
        if mn:
            hosts.append(f"{prefix}{mn}.googlevideo.com")
    hosts.append(current)
    out = []
    for h in hosts:
        if h not in out:
            out.append(h)
    return out


def with_host(url, host):
    parsed = urlparse(url)
    return urlunparse(parsed._replace(netloc=host))


def try_download(url, dest):
    for host in host_candidates(url):
        candidate = with_host(url, host)
        part = dest.with_suffix(dest.suffix + ".part")
        part.unlink(missing_ok=True)
        print(f"download via {host} -> {dest.name}", flush=True)
        cmd = [
            "curl",
            "--http1.1",
            "-L",
            "--fail",
            "--connect-timeout",
            "15",
            "--speed-time",
            "90",
            "--speed-limit",
            "1024",
            "-A",
            "Mozilla/5.0",
            candidate,
            "-o",
            str(part),
        ]
        proc = subprocess.run(cmd)
        if proc.returncode == 0 and part.exists() and part.stat().st_size > 1024:
            part.replace(dest)
            return
        part.unlink(missing_ok=True)
    raise RuntimeError(f"Could not download {dest}")


def main():
    if len(sys.argv) != 3:
        print("Usage: download_youtube_alt_host.py <youtube-url> <output.mp4>", file=sys.stderr)
        return 2

    video_url = sys.argv[1]
    output = Path(sys.argv[2])
    output.parent.mkdir(parents=True, exist_ok=True)
    data = extract(video_url)
    if video_quality() == "720p":
        format_ids = ["298", "136", "299", "137", "303"]
    else:
        format_ids = ["299", "137", "303", "298", "136"]
    video = pick(data["formats"], format_ids)
    audio = pick(data["formats"], ["140", "251"])

    tmp_video = output.with_suffix(".video." + video["ext"])
    tmp_audio = output.with_suffix(".audio." + audio["ext"])
    merged = output.with_suffix(".merge.mp4")
    for p in [tmp_video, tmp_audio, merged, output]:
        p.unlink(missing_ok=True)

    try_download(video["url"], tmp_video)
    try_download(audio["url"], tmp_audio)
    run([
        "ffmpeg",
        "-y",
        "-i",
        str(tmp_video),
        "-i",
        str(tmp_audio),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        str(merged),
    ])
    merged.replace(output)
    tmp_video.unlink(missing_ok=True)
    tmp_audio.unlink(missing_ok=True)
    run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(output)])
    print(f"done {output}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
