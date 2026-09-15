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

if [[ ! -x "$FOCUS" ]]; then
  echo "missing $FOCUS" >&2
  exit 1
fi

# Reskin in place rather than bailing out: an already-installed launcher kept
# whatever icon Odin had on the day it was compiled, and nothing ever refreshed
# it — so the old icon stayed in the Dock, Spotlight and every banner macOS
# draws by app name. Only the osacompile is skipped; the icon and the Launch
# Services record are rewritten on every run.
if [[ -d "$APP" && "${1:-}" != "--force" ]]; then
  echo "$APP already installed — refreshing icon (--force to rebuild)"
else
  osacompile -o "$APP" -e "do shell script \"$FOCUS\"" || exit 1
fi

# The dev icon from the repo, not /Applications/Odin.app's: this launcher starts
# the DEV app (green), and sourcing it from the release meant no icon at all
# until one was installed.
cp "$REPO/apps/desktop/src/resources/build/icons/icon-dev.icns" \
  "$APP/Contents/Resources/applet.icns"
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
