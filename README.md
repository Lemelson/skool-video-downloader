# Skool Video Downloader & Course Archiver

> A command-line toolkit to **download and back up your own Skool videos, lessons, attached files, and community posts** for offline access — built on the Chrome DevTools Protocol (CDP), Playwright, `yt-dlp`, and `ffmpeg`.

**Keywords:** skool downloader, download skool videos, skool video downloader, skool course downloader, backup skool classroom, archive skool community, save skool lessons offline, skool export tool.

---

## About

**Skool Video Downloader** is an open-source set of scripts for creating a personal, offline backup of course material and community content on [Skool](https://www.skool.com) that **you already have legitimate access to** — for example a course you purchased or a community you are a paying member of.

It drives a real, logged-in Brave or Chrome session over the Chrome DevTools Protocol (CDP), so it uses *your own* authenticated session and never asks for or stores your password. It can:

- Read the classroom/course structure and list all courses and lessons you can access.
- Download all videos with customizable quality (`720p`, `1080p`, `best`) from Wistia, YouTube, Loom, Vimeo, etc.
- Download attached PDF resources, lesson notes, and descriptions.
- Archive community feed posts into clean local HTML/Markdown/JSON for offline reading.
- Re-encode or optimize videos to save disk space.

Everything runs locally on your machine. Nothing is uploaded anywhere.

---

## ⚖️ Legal & responsible use — read this first

This project ships **only the tooling** (source code). It does **not** contain, host, or distribute any copyrighted course material, videos, transcripts, or other people's content.

By using these scripts you agree that:

- You will only download or archive content you have **lawful, authorized access to** — e.g. a course you paid for or a community you are a member of.
- You will use any downloaded material **for your own personal, offline use only** (a private backup).
- You will **not** redistribute, re-upload, resell, publicly share, or otherwise infringe the copyright of course creators or community members.
- You are solely responsible for complying with Skool's Terms of Service, the rights of content creators, and the laws of your jurisdiction.

---

## Requirements

- **[Node.js](https://nodejs.org/) 18+**
- **[Python](https://www.python.org/) 3.9+**
- **Brave Browser** or **Google Chrome**
- **[Playwright](https://playwright.dev/)**
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** (`/opt/homebrew/bin/yt-dlp` or on system `PATH`)
- **[ffmpeg](https://ffmpeg.org/) / ffprobe**

Install dependencies:

```bash
# Node dependencies
npm install

# Python tools (yt-dlp, if not installed via Homebrew)
python3 -m pip install -U yt-dlp

# ffmpeg (macOS)
brew install ffmpeg
```

---

## ⚙️ Configuration (`.env`)

Create a `.env` file in the project root (or copy from `.env.example`):

```env
# Root directory for backups
SKOOL_ARCHIVE_ROOT=/Volumes/Downloads
SKOOL_COLLECTION_NAME=Skool

# Default target URLs (optional - can also be passed via CLI)
SKOOL_CLASSROOM_URL=https://www.skool.com/community-name/classroom
SKOOL_COMMUNITY_URL=https://www.skool.com/community-name

# Desired video quality: 720p, 1080p, or best
VIDEO_QUALITY=720p

# Path to yt-dlp binary
YTDLP=/opt/homebrew/bin/yt-dlp

# Text-only feed archiving (0 = download media, 1 = text only)
SKOOL_TEXT_ONLY=0
MAX_ATTACHMENT_MB=30
```

---

## 🌐 Browser Launch (Brave / Chrome CDP)

The scripts attach to a running, logged-in browser session via CDP on port `9222`.

### Launching Brave Browser:
Run using the npm script:
```bash
npm run launch:brave
```
Or using the system alias `brave-cdp`:
```bash
brave-cdp
```

#### Installing the `brave-cdp` Alias
To run `brave-cdp` from anywhere in your shell, add an alias pointing to `scripts/launch_brave_cdp.sh` in your shell configuration file (`~/.zshrc` for zsh or `~/.bash_aliases` / `~/.bashrc` for bash):

```bash
# Add to ~/.zshrc or ~/.bash_aliases / ~/.bashrc
alias brave-cdp="bash /path/to/skool-video-downloader/scripts/launch_brave_cdp.sh"
```

After adding the alias, reload your shell configuration:
```bash
source ~/.zshrc # or source ~/.bash_aliases / source ~/.bashrc
```

### Launching Chrome Browser manually:
```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.skool-archive-chrome"
```

> **Note:** Log in to your Skool account in the browser window that opens.

---

## 🎯 Supported Downloading Scenarios & Examples

### Scenario 1: One-Command Download for a Single Course (Videos + Notes + PDFs)
To download **everything** for a specific course (videos, lesson notes, and attached PDFs/files) in a single command:

```bash
npm run download:all https://www.skool.com/community-name/classroom/<COURSE_ID>
```
*(If no URL is passed, it uses `SKOOL_CLASSROOM_URL` from `.env`)*

---

### Scenario 2: One-Command Download for ALL Courses in Entire Classroom
To automatically discover and download **all courses, all lesson notes, all PDFs, and all videos** across the entire community classroom:

```bash
npm run download:everything https://www.skool.com/community-name/classroom
```
*(If no URL is passed, it uses `SKOOL_CLASSROOM_URL` from `.env`)*

---

### Scenario 3: Step-by-Step Granular Execution
If you prefer step-by-step control over what gets downloaded:

1. **Check browser connection:**
   ```bash
   npm run inspect
   ```
2. **Fetch course structure:**
   ```bash
   npm run course:state https://www.skool.com/community-name/classroom/<COURSE_ID>
   ```
3. **Download lesson notes and attachments (PDFs/Google Drive links):**
   ```bash
   npm run download:details https://www.skool.com/community-name/classroom/<COURSE_ID>
   ```
4. **Download video files with configured quality (`VIDEO_QUALITY=720p`):**
   ```bash
   npm run download:videos
   ```

---

### Scenario 4: Archive Community Discussions & Posts
To download the community posts feed into offline HTML/Markdown/JSON:

```bash
npm run archive:community https://www.skool.com/community-name
```

---

### Scenario 5: Re-encode & Optimize Video Disk Space
To compress and re-encode downloaded videos to target resolution (e.g. 720p/1080p):

```bash
npm run optimize:videos
```

---

## 📜 Available NPM Scripts

| Command | Action |
| --- | --- |
| `npm run launch:brave` | Launches Brave Browser in CDP mode on port 9222 |
| `npm run inspect` | Inspects active tabs in the connected browser session |
| `npm run download:all` | **All-in-one:** Downloads videos, notes, and PDFs for a **single course** |
| `npm run download:everything` | **All-in-one:** Downloads **ALL courses** in the classroom automatically |
| `npm run course:state` | Fetches course/lesson structure and dumps to `course-state.json` |
| `npm run download:details` | Downloads lesson descriptions, notes, and attached resources |
| `npm run download:pdf` | Downloads attached PDF resources from lessons |
| `npm run download:videos` | Downloads video files with configured quality (`VIDEO_QUALITY`) |
| `npm run archive:community` | Archives community feed into HTML/Markdown/JSON |
| `npm run archive:post` | Archives a single community post |
| `npm run optimize:videos` | Optimizes/compresses downloaded videos to target resolution |

---

## License

Released under the [MIT License](LICENSE). Provided "as is", without warranty of any kind. You are responsible for how you use it.
