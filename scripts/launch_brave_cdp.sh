#!/bin/bash

###############################################################################
# Script to launch Brave Browser with Chrome DevTools Protocol (CDP) port open (9222).
# Enables integration with tools such as skool-video-downloader.
###############################################################################

PORT="${1:-9222}"
USER_DATA_DIR="${SKOOL_BRAVE_PROFILE:-$HOME/.skool-archive-brave}"
BRAVE_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"

if lsof -i :"$PORT" >/dev/null 2>&1; then
  echo "[INFO] Port $PORT is already in use. Browser with CDP is likely already running."
  exit 0
fi

if [ ! -f "$BRAVE_PATH" ]; then
  echo "[ERROR] Brave Browser not found at path: $BRAVE_PATH"
  exit 1
fi

echo "[INFO] Launching Brave Browser with open CDP port $PORT..."
echo "[INFO] User data profile: $USER_DATA_DIR"

"$BRAVE_PATH" --remote-debugging-port="$PORT" --user-data-dir="$USER_DATA_DIR" >/dev/null 2>&1 &

echo "[SUCCESS] Brave Browser has been launched in the background."
echo "[TIP] Log in to the Skool platform in the newly opened browser window."
