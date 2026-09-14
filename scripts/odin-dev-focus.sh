#!/usr/bin/env bash

# Raycast reads these; it lists a script only if they're present, and it can't
# pick a file directly — add this directory under Extensions → Script Commands.
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Odin Dev
# @raycast.mode silent
# Optional parameters:
# @raycast.icon ⚡
# @raycast.packageName Odin
# @raycast.description Focus the Odin dev app, or start it from source

# Bind the launcher hotkey (Raycast ⌘`) to THIS, not to "Odin Dev.app".
#
#   scripts/odin-dev-focus.sh          # focus the dev app, or start it
#   scripts/odin-dev-focus.sh --check  # print what it sees, change nothing
#
# Launching the bundle directly — Raycast, the Dock, Recents, Spotlight — runs a
# bare Electron with no app path, and that is Electron's own welcome screen
# ("Electron path-to-app"), not Odin. Odin only exists when electron-vite hands
# the binary its entry point, so the hotkey has to start the dev stack, not the
# bundle. Dropping the Launch Services entry can't fix this: a launcher indexes
# the .app itself and launches it by path.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The dev UI is the one Electron under this checkout that was GIVEN an app path.
# The terminal-host daemon and every live session run the same binary from the
# same bundle, so the trailing argument is the only thing separating them — and
# it's why this must never grow into a pkill.
#
# ps, not pgrep: pgrep silently skips processes whose executable moved out from
# under them, which is routine here (see odin-procs.sh).
dev_ui_pid() {
  ps ax -o pid=,command= |
    grep -F 'dist/Odin Dev.app/Contents/MacOS/Electron .' |
    grep -vw grep |
    awk 'NR==1 {print $1}'
}

pid="$(dev_ui_pid)"

if [[ "${1:-}" == "--check" ]]; then
  if [[ -n "$pid" ]]; then echo "dev UI running, pid $pid"; else echo "dev UI not running"; fi
  exit 0
fi

if [[ -n "$pid" ]]; then
  # Raise the window we already have. Re-running the dev script here would tear
  # down vite and every renderer to rebuild what's already on screen.
  osascript -e \
    "tell application \"System Events\" to set frontmost of first process whose unix id is $pid to true" \
    >/dev/null 2>&1
  exit 0
fi

# Detached, NOT exec'd: odin-dev.sh runs bun dev in the foreground and never
# returns, and a launcher waits for the script command it invoked — Raycast
# would sit on a spinner for the whole dev session. It already tees everything
# to the log, so there is no output to keep here.
LOG="${ODIN_HOME_DIR:-$HOME/.odin}/dev.log"
nohup "$REPO/scripts/odin-dev.sh" >/dev/null 2>&1 &
disown
echo "starting Odin dev — logs: $LOG"
