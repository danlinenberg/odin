#!/usr/bin/env bash
# The App Store screenshots (6.9-inch iPhone, 1320x2868), from fake-odin's
# sample sessions: bun run screenshots
#
# No simulator: starts fake-odin, the dev server and a headless Google Chrome,
# drives each screen from screenshots.ts, and saves
# store/screenshots/iphone-6.9/*.png without an alpha channel (App Store
# Connect refuses one). Stops what it started at the end.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=store/screenshots/iphone-6.9
TMP=$(mktemp -d)
mkdir -p "$OUT"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

bun scripts/fake-odin.ts > "$TMP/fake.log" 2>&1 &
FAKE=$!
bunx vite --port 5175 --strictPort > "$TMP/vite.log" 2>&1 &
VITE=$!
"$CHROME" --headless=new --remote-debugging-port=9333 --user-data-dir="$TMP/chrome" \
  --no-first-run --hide-scrollbars about:blank > "$TMP/chrome.log" 2>&1 &
BROWSER=$!
cleanup() {
  kill "$FAKE" "$VITE" "$BROWSER" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT
sleep 6

LINK=$(grep -o 'odin://pair[^"]*' "$TMP/fake.log")
bun scripts/screenshots.ts "$OUT" "$LINK"
python3 scripts/strip-alpha.py "$OUT"/*.png

for f in "$OUT"/*.png; do
  echo "$f $(sips -g pixelWidth -g pixelHeight -g hasAlpha "$f" | awk '/pixel|hasAlpha/{printf $2" "}')"
done
