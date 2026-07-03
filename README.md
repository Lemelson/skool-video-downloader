# Skool Video Downloader & Course Archiver

> A command-line toolkit to **download and back up your own Skool videos, lessons, and community posts** for offline access — built on the Chrome DevTools Protocol (CDP), Playwright, `yt-dlp`, and `ffmpeg`.

**Keywords:** skool downloader, download skool videos, skool video downloader, skool course downloader, backup skool classroom, archive skool community, save skool lessons offline, skool export tool.

---

## About

**Skool Video Downloader** is an open-source set of scripts for creating a personal, offline backup of course material and community content on [Skool](https://www.skool.com) that **you already have legitimate access to** — for example a course you purchased or a community you are a paying member of.

It drives a real, logged-in Chrome session over the Chrome DevTools Protocol, so it uses *your own* authenticated session and never asks for or stores your password. It can:

- Read the classroom/course structure and list the lessons you can access.
- Capture the media URLs behind lessons and download the videos you have access to.
- Download attached PDF resources.
- Archive community feed posts you can see into clean local HTML/Markdown/JSON for offline reading.
- Re-encode large videos to a sensible 1080p size to save disk space.

Everything runs locally on your machine. Nothing is uploaded anywhere.

---

## ⚖️ Legal & responsible use — read this first

This project ships **only the tooling** (source code). It does **not** contain, host, or distribute any copyrighted course material, videos, transcripts, or other people's content.

By using these scripts you agree that:

- You will only download or archive content you have **lawful, authorized access to** — e.g. a course you paid for or a community you are a member of.
- You will use any downloaded material **for your own personal, offline use only** (a private backup).
- You will **not** redistribute, re-upload, resell, publicly share, or otherwise infringe the copyright of course creators or community members.
- You are solely responsible for complying with Skool's Terms of Service, the rights of content creators, and the laws of your jurisdiction.

A downloader is a neutral tool — much like `yt-dlp` or a browser's "Save As". How you use it is your responsibility. If you are a course creator and don't want members to keep offline copies, that is a matter between you and your members and their agreement with the platform. **The authors of this project do not endorse piracy and accept no liability for misuse.**

---

## Requirements

- **[Node.js](https://nodejs.org/) 18+** (for the `.js` archiver scripts)
- **[Python](https://www.python.org/) 3.9+** (for the `.py` download/encode helpers)
- **[Google Chrome](https://www.google.com/chrome/)** (used in remote-debugging mode)
- **[Playwright](https://playwright.dev/)** Chromium bindings: `npm install playwright`
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** (for videos hosted on YouTube-style backends)
- **[ffmpeg](https://ffmpeg.org/) / ffprobe** (for muxing and re-encoding)

Install the toolchain:

```bash
# Node dependencies
npm install

# Python tools (into a virtualenv is recommended)
python3 -m pip install -U yt-dlp

# ffmpeg (macOS)
brew install ffmpeg
# ffmpeg (Debian/Ubuntu)
sudo apt-get install ffmpeg
```

---

## Setup: start Chrome with remote debugging

The archiver scripts attach to an already-running, logged-in Chrome via CDP on port `9222`. Quit Chrome fully, then launch it with remote debugging enabled and **log in to Skool normally** in that window.

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.skool-archive-chrome"

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.skool-archive-chrome"

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.skool-archive-chrome"
```

Then set where output should be written (defaults to the current directory):

```bash
export SKOOL_ARCHIVE_ROOT="$HOME/Skool-Backup"
```

---

## Configuration

The scripts read a few environment variables so nothing is hardcoded:

| Variable | Purpose | Default |
| --- | --- | --- |
| `SKOOL_ARCHIVE_ROOT` | Root folder where archives/downloads are written | current directory |
| `SKOOL_CLASSROOM_URL` | Full URL of the classroom/course you have access to | — (or pass as CLI arg) |
| `SKOOL_COMMUNITY_URL` | Full URL of the community feed you want to archive | — (or pass as CLI arg) |
| `YTDLP` | Path to the `yt-dlp` binary | `yt-dlp` on `PATH` |

Most scripts also accept the relevant URL/ID as a command-line argument, which takes priority over the environment variable. Run any script with no arguments to see its usage.

---

## Scripts

| Script | What it does |
| --- | --- |
| `scripts/cdp_inspect.js` | List the pages/tabs open in the attached Chrome session (sanity check that CDP is connected). |
| `scripts/cdp_course_state.js` | Read the classroom's `__NEXT_DATA__` and dump the course tree — sections, modules, access flags, video links, durations. |
| `scripts/cdp_capture_media.js` | Open a lesson, play it, and capture the underlying media/manifest URLs from network traffic. |
| `scripts/cdp_download_lesson_details.js` | Walk lessons you can access and download their details/media using your session cookies. |
| `scripts/cdp_download_pdf_resources.js` | Download PDF resources attached to lessons. |
| `scripts/cdp_download_url.js` | Fetch a single URL through the browser session and save the response body. |
| `scripts/cdp_archive_skool_community.js` | Archive a community feed into local HTML/Markdown/JSON. |
| `scripts/cdp_archive_skool_post.js` | Archive a single community post (with formatting, links and mentions preserved). |
| `scripts/capture_skool_feed_from_chrome_clipboard.js` | Capture the currently-loaded feed straight from the browser via the clipboard. |
| `scripts/archive_new_posts_from_source_check.js` | Incrementally archive only posts that are new since your last run. |
| `scripts/update_community_from_incremental_check.js` | Update an existing local community archive with new/changed posts. |
| `scripts/download_accessible_videos.py` | Batch-download the videos your account can access. |
| `scripts/download_youtube_alt_host.py` | Robustly download a YouTube-backed video, trying alternate CDN hosts, and mux with `ffmpeg`. |
| `scripts/optimize_videos_1080p.py` | Re-encode oversized videos down to efficient 1080p to reclaim disk space. |

### Examples

```bash
# 0) Confirm the CDP connection works
node scripts/cdp_inspect.js

# 1) Dump the course structure of a classroom you have access to
node scripts/cdp_course_state.js "https://www.skool.com/<community>/classroom/<id>"

# 2) Capture the media URLs for a specific lesson/module
node scripts/cdp_capture_media.js <moduleId>

# 3) Archive a community feed for offline reading
node scripts/cdp_archive_skool_community.js "https://www.skool.com/<community>"

# 4) Save disk space on already-downloaded videos
python3 scripts/optimize_videos_1080p.py
```

---

## How it works

1. You log in to Skool in a normal Chrome window that was started with `--remote-debugging-port=9222`.
2. The scripts attach to that window over the Chrome DevTools Protocol (`http://127.0.0.1:9222`) — they reuse **your** session, so there are no credentials to store.
3. For structured data, they read the page's embedded `__NEXT_DATA__` JSON. For media, they observe network requests to find the real video/manifest URLs.
4. Downloads are performed with your session cookies; YouTube-hosted media is fetched with `yt-dlp` and muxed with `ffmpeg`.
5. Community posts are converted into clean, self-contained local HTML/Markdown/JSON.

---

## FAQ

**Does this need my Skool password?**
No. It attaches to a Chrome window where *you* are already logged in. Credentials never touch the scripts.

**Can it download content I haven't paid for?**
No. It can only reach what your logged-in account can already see. It is a convenience/backup tool, not a bypass.

**Where do files go?**
Into `SKOOL_ARCHIVE_ROOT` (or the current directory if unset).

**Is this affiliated with Skool?**
No. This is an independent, unofficial tool. "Skool" is a trademark of its respective owner and is used here only descriptively.

---

## License

Released under the [MIT License](LICENSE). Provided "as is", without warranty of any kind. You are responsible for how you use it.
