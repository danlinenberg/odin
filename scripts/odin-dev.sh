#!/usr/bin/env bash
# Run Odin from source with hot reload — edits to the views apply instantly, no
# rebuild. Use this while changing Odin; use the packaged /Applications/Odin.app
# (built by odin-update.sh) for normal work.
#
#   scripts/odin-dev.sh
#
# Only one Odin can run at a time: both use ~/.odin (same terminal-host socket
# and app-state), and Electron's single-instance lock would kill the second.
# So this quits the packaged app first — but only its UI. The terminal-host
# daemon is left running and the dev app adopts it, so open sessions stay live
# through the hot-reload loop, and through leaving dev mode: the dev daemon is
# spawned detached and is no longer torn down on quit either.
#
# A daemon running a stale terminal-host.js is still restarted, but only when
# that bundle's contents actually changed (client.ts hashes it), not on every
# rebuild — which is what used to kill every session on every restart.
set -uo pipefail

# A GUI launcher gives us PATH=/usr/bin:/bin:/usr/sbin:/sbin — no Homebrew — so
# the `bun dev` at the bottom died with "env: bun: No such file or directory"
# and the Raycast hotkey looked like it did nothing at all.
export PATH="/opt/homebrew/bin:$PATH"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "odin-dev: bun not found in PATH=$PATH" >&2
  exit 1
fi

[[ -d "/Applications/Odin Dev.app" ]] ||
  "$REPO/scripts/odin-dev-install-launcher.sh" || true

# shellcheck source=scripts/odin-procs.sh
source "$REPO/scripts/odin-procs.sh"
LOG="${ODIN_HOME_DIR:-$HOME/.odin}/dev.log"
mkdir -p "$(dirname "$LOG")"

# Keep the run that just died. `tee` truncates, so the restart that follows a
# crash wiped the only copy of its stack trace — every crash here was diagnosed
# from a log the restart had already deleted. The dying run lands in dev.log.prev.
# ponytail: one generation; rotate to .1/.2 if comparing several crashes matters.
[[ -s "$LOG" ]] && mv -f "$LOG" "$LOG.prev"

# Say who asked for this start. A window that vanishes and comes back is only
# explainable if the run that replaced it records what replaced it — and every
# echo below goes to the caller's stdout, which Raycast and `nohup` discard.
# So the answer to "why did Odin just restart?" was never written down anywhere.
{
  echo "=== odin-dev start $(date '+%F %T') pid=$$ ==="
  if [[ -n "${ODIN_QUIT_PID:-}" ]]; then
    echo "    trigger: in-app Restart Odin, quitting pid $ODIN_QUIT_PID"
  else
    echo "    trigger: fresh launch (hotkey, shell, or login)"
  fi
  # comm=, not command=: a parent shell's argv carries exported secrets here
  # (CLAUDE_* tokens), and this log is world-readable plain text. Name only.
  echo "    invoked by: $(ps -o comm= -p "$PPID" 2>/dev/null | cut -c1-120) (ppid $PPID)"
} >>"$LOG"

if [[ -n "$(ui_pids)" ]]; then
  echo "quitting the packaged Odin (its sessions stay live)…"
  quit_packaged_ui
fi

# Also quit a dev stack that's already up, so re-running this script is a
# restart — what the "Restart Odin" button does.
#
# Only the runners are matched by pattern. Every OTHER Electron process under
# this checkout is unsafe to pattern-match: the terminal-host daemon and every
# live session (pty-subprocess.js) run the same `Odin Dev.app` binary from the
# same node_modules, so killing by path closes real sessions. The dev UI is
# killed by pid instead — the app passes its own in ODIN_QUIT_PID when it
# triggers the restart.
if [[ -n "${ODIN_QUIT_PID:-}" ]]; then
  echo "quitting the running dev Odin, pid $ODIN_QUIT_PID (its sessions stay live)…"
  kill "$ODIN_QUIT_PID" 2>/dev/null
fi
pkill -f "$REPO.*electron-vite dev" 2>/dev/null && sleep 2
pkill -f "$REPO.*turbo run dev" 2>/dev/null

# patch-dev-protocol.ts registers the dev bundle with Launch Services so
# odin-*:// deep links reach it. Registered but NOT running it's a trap:
# "Odin Dev" stays openable from Spotlight, and opening it launches the bare
# Electron binary with no app path — Electron's own welcome screen ("Electron
# path-to-app"), not Odin. So the entry only lives as long as the dev stack;
# predev re-registers on the next start.
# ponytail: EXIT trap only — a SIGKILL leaves the entry behind until next start.
DEV_BUNDLE="$REPO/apps/desktop/node_modules/electron/dist/Odin Dev.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
trap '"$LSREGISTER" -u "$DEV_BUNDLE" >/dev/null 2>&1' EXIT

echo "starting Odin with hot reload — logs: $LOG"
echo "  edits under apps/desktop/src/renderer/  apply immediately"
echo "  edits under apps/desktop/src/main/      need the Restart Odin button"
echo "     (ODIN_DEV_WATCH=--watch restores restart-on-save, storm included)"
echo "  ctrl-c here to stop"

cd "$REPO"
# SKIP_ENV_VALIDATION drops the login gate; the debug port lets tooling drive
# and screenshot the window.
exec env SKIP_ENV_VALIDATION=1 ODIN_PACKAGE=1 RENDERER_REMOTE_DEBUG_PORT=19223 \
  bun dev 2>&1 | tee -a "$LOG"
