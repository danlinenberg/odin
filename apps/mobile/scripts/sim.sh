#!/usr/bin/env bash
# Build Odin for the iOS Simulator, install it, open it.
#
#   bun run sim            the bundled screens, as on a phone
#   bun run sim --live     the screens from `bun run dev`: edits show at once,
#                          with the sample sessions of `bun run fake-odin`
#
# ODIN_SIM_DEVICE picks the simulator (default: the first available iPhone).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--live" ]]; then
  # Paired with `bun run fake-odin` through the dev server's proxy.
  export ODIN_LIVE_URL="${ODIN_LIVE_URL:-http://localhost:5175/?t=fake}"
else
  bunx vite build
fi
bunx cap sync ios

DEVICE="${ODIN_SIM_DEVICE:-$(xcrun simctl list devices available | grep -m1 -oE 'iPhone[^(]*' | sed 's/ *$//')}"
[[ -n "$DEVICE" ]] || { echo "No iPhone simulator: xcodebuild -downloadPlatform iOS" >&2; exit 1; }

DD=build/sim
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator \
  -destination "platform=iOS Simulator,name=$DEVICE" -derivedDataPath "$DD" \
  CODE_SIGNING_ALLOWED=NO -quiet build

xcrun simctl boot "$DEVICE" 2>/dev/null || true
# The window, when this Xcode ships one; simctl runs it headless either way.
open -a Simulator 2>/dev/null || true
xcrun simctl install booted "$DD/Build/Products/Debug-iphonesimulator/App.app"
xcrun simctl launch booted com.danlinenberg.odin
