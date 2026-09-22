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
    grep -E "^ *[0-9]+ $REPO/.*/dist/[^/]+\.app/Contents/MacOS/Electron \.$" |
    grep -vw grep |
    awk 'NR==1 {print $1}'
}

# dev_stack_lines (odin-procs.sh) lists every live odin-dev.sh, from ANY
# checkout — the session guard in odin-dev.sh allows only one, so a stack in
# another worktree means the hotkey has nothing to start here either.
#
# Checking for the stack at all matters because a start takes 17s to ~2min
# (predev, vite, then Electron), and for all of it dev_ui_pid is empty: the UI
# genuinely isn't up yet. Without it the hotkey reads that as "not running" and
# starts a SECOND stack, whose pkill kills the boot already in progress — so the
# hotkey pressed to get Odin back is what kept taking it away, and it read as a
# crash.
# shellcheck source=scripts/odin-procs.sh
source "$REPO/scripts/odin-procs.sh"

pid="$(dev_ui_pid)"
stack="$(dev_stack_lines | head -1)"
stack_pid="${stack%% *}"
stack_repo="${stack#* }"

if [[ "${1:-}" == "--check" ]]; then
  if [[ -n "$pid" ]]; then echo "dev UI running, pid $pid"; else echo "dev UI not running"; fi
  if [[ -n "$stack" ]]; then echo "dev session alive in $stack_repo, odin-dev.sh pid $stack_pid"; fi
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

if [[ -n "$stack" ]]; then
  if [[ "$stack_repo" == "$REPO" ]]; then
    echo "Odin dev is already starting (odin-dev.sh pid $stack_pid) — leaving it to finish"
    exit 0
  fi
  # Another checkout holds the session. From the main checkout that's a refusal,
  # so say so here rather than spawning a start that odin-dev.sh will reject.
  # From a worktree it isn't: fall through and let the start take the session.
  if ! is_linked_worktree "$REPO"; then
    echo "a dev session is already running in $stack_repo (pid $stack_pid) — only one runs at a time"
    exit 0
  fi
  echo "taking the dev session from $stack_repo (pid $stack_pid)…"
fi

# Detached, NOT exec'd: odin-dev.sh runs bun dev in the foreground and never
# returns, and a launcher waits for the script command it invoked — Raycast
# would sit on a spinner for the whole dev session. It already tees everything
# to the log, so there is no output to keep here.
LOG="${ODIN_HOME_DIR:-$HOME/.odin}/dev.log"
nohup "$REPO/scripts/odin-dev.sh" >/dev/null 2>&1 &
disown
echo "starting Odin dev — logs: $LOG"
