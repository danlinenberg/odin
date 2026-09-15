#!/usr/bin/env bash
# Rebuild Odin from this checkout and reinstall it into /Applications.
#
# Safe to trigger from inside Odin: it must NOT be a child of the app (quitting
# Odin would kill it mid-build), so the app spawns it detached. Run it by hand
# the same way:  scripts/odin-update.sh [--pull]
#
# Order matters — build first while the old app still runs, and only swap the
# bundle once the UI has quit.
#
# Open terminal sessions are preserved: the terminal-host daemon is left running
# and the new app reconnects to it. See the "keep open terminal sessions alive"
# block for the two things that makes necessary (a protocol-version guard, and
# renaming the old bundle rather than overwriting it).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/odin-procs.sh
source "$REPO/scripts/odin-procs.sh"
LOG="${ODIN_HOME_DIR:-$HOME/.odin}/update.log"
mkdir -p "$(dirname "$LOG")"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG"; }

log "=== Odin update from $REPO ==="

if [[ "${1:-}" == "--pull" ]]; then
  log "pulling latest main…"
  git -C "$REPO" pull --ff-only origin main >>"$LOG" 2>&1 ||
    git -C "$REPO" pull --ff-only personal main >>"$LOG" 2>&1 ||
    log "pull failed (continuing with the local checkout)"
fi

log "commit: $(git -C "$REPO" log --oneline -1)"

log "building (a few minutes)…"
if ! (cd "$REPO/apps/desktop" &&
  SKIP_ENV_VALIDATION=1 ODIN_PACKAGE=1 bun run build >>"$LOG" 2>&1); then
  # electron-builder's DMG step fails intermittently on a plist parse; the .app
  # is complete by then, so only bail if the bundle itself is missing.
  if [[ ! -d "$REPO/apps/desktop/release/mac-arm64/Odin.app" ]]; then
    log "BUILD FAILED — see $LOG"
    exit 1
  fi
  log "packaging step failed after the app was built (usually the DMG) — continuing"
fi

APP="$REPO/apps/desktop/release/mac-arm64/Odin.app"
[[ -d "$APP" ]] || { log "no app bundle at $APP"; exit 1; }

# --- keep open terminal sessions alive across the update --------------------
# The terminal-host daemon is spawned detached and outlives the UI, so sessions
# already survive a plain quit. It only has to be restarted when the wire
# protocol moved: the client throws on a PROTOCOL_VERSION mismatch rather than
# degrading, so an old daemon would wedge the new app.
ODIN_HOME="$HOME/.odin" # matches ODIN_HOME_DIR in terminal-host/client.ts
PROTO_STAMP="$ODIN_HOME/daemon-protocol-version"
NEW_PROTO="$(grep -oE '^export const PROTOCOL_VERSION = [0-9]+' \
  "$REPO/apps/desktop/src/main/lib/terminal-host/types.ts" 2>/dev/null |
  grep -oE '[0-9]+$')"
OLD_PROTO="$(cat "$PROTO_STAMP" 2>/dev/null || true)"

log "quitting Odin…"
quit_packaged_ui

if [[ -n "$NEW_PROTO" && "$NEW_PROTO" == "$OLD_PROTO" ]]; then
  log "keeping the terminal-host daemon (protocol v$NEW_PROTO unchanged) — sessions survive"
else
  log "daemon protocol ${OLD_PROTO:-unknown} → ${NEW_PROTO:-unknown} — restarting it; open sessions will be lost"
  for pid in $(daemon_pids); do kill "$pid" 2>/dev/null || true; done
  sleep 2
fi

log "installing to /Applications…"
# A preserved daemon is executing from inside the installed bundle, so the
# bundle can't be overwritten in place. Rename it instead: the old inode stays
# valid and the daemon keeps running from it until it is next replaced.
STALE_DIR="$ODIN_HOME/stale"
mkdir -p "$STALE_DIR"
# Sweep bundles parked by earlier updates, minus the one the live daemon is on.
# Its argv still reads /Applications (argv is frozen at exec), so only lsof can
# say which bundle it actually holds open.
LIVE_BUNDLE=""
DAEMON_PID="$(daemon_pids | head -1)"
[[ -n "$DAEMON_PID" ]] &&
  LIVE_BUNDLE="$(lsof -p "$DAEMON_PID" -Fn 2>/dev/null |
    grep -m1 -oE "$STALE_DIR/Odin-[0-9]+\.app" || true)"
for old in "$STALE_DIR"/Odin-*.app; do
  [[ -d "$old" && "$old" != "$LIVE_BUNDLE" ]] && rm -rf "$old"
done

STALE="$STALE_DIR/Odin-$(date +%s).app"
if [[ -d /Applications/Odin.app ]]; then
  mv /Applications/Odin.app "$STALE" ||
    { log "could not move the installed bundle aside"; exit 1; }
fi
if ! ditto "$APP" /Applications/Odin.app >>"$LOG" 2>&1; then
  log "INSTALL FAILED — restoring the previous bundle"
  rm -rf /Applications/Odin.app
  [[ -d "$STALE" ]] && mv "$STALE" /Applications/Odin.app
  exit 1
fi
[[ -n "$NEW_PROTO" ]] && printf '%s\n' "$NEW_PROTO" >"$PROTO_STAMP"
xattr -dr com.apple.quarantine /Applications/Odin.app >/dev/null 2>&1 || true
touch /Applications/Odin.app

log "relaunching…"
open -a /Applications/Odin.app
log "=== done ==="
