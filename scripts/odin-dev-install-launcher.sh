#!/usr/bin/env bash

#   scripts/odin-dev-install-launcher.sh [--force]
#
# Installs /Applications/Odin Dev.app, an applet that runs odin-dev-focus.sh.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MAIN="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
MAIN="${MAIN%/.git}"
if [[ -n "$MAIN" && -f "$MAIN/scripts/odin-dev-focus.sh" ]]; then
  REPO="$MAIN"
fi

APP="/Applications/Odin Dev.app"
FOCUS="$REPO/scripts/odin-dev-focus.sh"
BUNDLE_ID="com.dan.odin.dev.launcher"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if [[ -d "$APP" && "${1:-}" != "--force" ]]; then
  echo "$APP already installed (--force to rebuild)"
  exit 0
fi

if [[ ! -x "$FOCUS" ]]; then
  echo "missing $FOCUS" >&2
  exit 1
fi

osacompile -o "$APP" -e "do shell script \"$FOCUS\"" || exit 1

ICON="/Applications/Odin.app/Contents/Resources/icon.icns"
if [[ -f "$ICON" ]]; then
  cp "$ICON" "$APP/Contents/Resources/applet.icns"
fi
/usr/libexec/PlistBuddy -c "Set :CFBundleName Odin Dev" \
  "$APP/Contents/Info.plist" >/dev/null 2>&1
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string $BUNDLE_ID" \
  "$APP/Contents/Info.plist" >/dev/null 2>&1 ||
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" \
    "$APP/Contents/Info.plist" >/dev/null 2>&1
codesign --force --sign - "$APP" >/dev/null 2>&1
touch "$APP"
"$LSREGISTER" -f "$APP" >/dev/null 2>&1

echo "installed $APP -> $FOCUS"
