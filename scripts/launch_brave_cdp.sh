#!/bin/bash

###############################################################################
# Launch Brave Browser (macOS) with the Chrome DevTools Protocol (CDP) port open,
# using a separate profile, so the scripts in this repo can attach to it.
#
# Usage: scripts/launch_brave_cdp.sh [port]        (default port: 9222)
# Env:   SKOOL_BRAVE_PROFILE  profile dir  (default: ~/.skool-archive-brave)
#        BRAVE_PATH           browser binary (default: the standard macOS install)
###############################################################################

PORT="${1:-9222}"
USER_DATA_DIR="${SKOOL_BRAVE_PROFILE:-$HOME/.skool-archive-brave}"
BRAVE_PATH="${BRAVE_PATH:-/Applications/Brave Browser.app/Contents/MacOS/Brave Browser}"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[INFO] Something is already listening on port $PORT. Browser with CDP is likely already running."
  exit 0
fi

if [ ! -x "$BRAVE_PATH" ]; then
  echo "[ERROR] Brave Browser not found at: $BRAVE_PATH"
  echo "        Install Brave, or set BRAVE_PATH to the browser binary."
  exit 1
fi

echo "[INFO] Launching Brave Browser with open CDP port $PORT..."
echo "[INFO] User data profile: $USER_DATA_DIR"

"$BRAVE_PATH" --remote-debugging-port="$PORT" --user-data-dir="$USER_DATA_DIR" >/dev/null 2>&1 &

echo "[SUCCESS] Brave Browser has been launched in the background."
echo "[TIP] Log in to the Skool platform in the newly opened browser window."
if [ "$PORT" != "9222" ]; then
  echo "[TIP] Non-default port: set SKOOL_CDP_URL=http://127.0.0.1:$PORT in .env so the scripts can find it."
fi
