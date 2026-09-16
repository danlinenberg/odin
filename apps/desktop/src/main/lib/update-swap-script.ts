/**
 * The bundle swap that installs a downloaded release — kept in its own file,
 * free of electron imports, so the shell it generates can be unit tested. It is
 * run detached by auto-updater.ts, because it outlives the process that spawns
 * it: that process is the app it replaces.
 */

/** Single-quote a path for the swap script. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The bundle swap, as a detached shell script — it outlives the process that
 * spawns it, because that process is the app it is replacing.
 */
export function swapScript({
	appBundle,
	mountPoint,
	workDir,
}: {
	appBundle: string;
	mountPoint: string;
	workDir: string;
}): string {
	return `set -uo pipefail
mkdir -p "$HOME/.odin" # a failed exec redirect would kill the script outright
exec >>"$HOME/.odin/update.log" 2>&1
APP=${shellQuote(appBundle)}
MNT=${shellQuote(mountPoint)}
WORK=${shellQuote(workDir)}
STALE_DIR="$HOME/.odin/stale"
echo "[$(date '+%H:%M:%S')] === in-app release update -> $APP ==="

# Wait for the UI to go. Two traps here, both load-bearing:
#  - the terminal-host daemon re-execs the SAME binary from the same bundle, so
#    it has to be excluded by argv (terminal-host.js), not by path;
#  - the match runs in bash, not through a grep for "$APP", because that
#    grep's own argv contains the path and so matches itself. The usual patch,
#    grep -vw grep, silently fails wherever grep is ugrep or ripgrep.
# Enumerate with ps, never pgrep — see scripts/odin-procs.sh for that one.
ui_running() {
  # read splits the pid off, so $cmd starts at argv[0] — a grep or an editor
  # that merely carries the bundle path in its arguments is not the UI.
  local pid cmd
  while read -r pid cmd; do
    case "$cmd" in
      "$APP/Contents/MacOS/Odin"*)
        case "$cmd" in *terminal-host.js*) ;; *) return 0 ;; esac ;;
    esac
  done < <(ps ax -o pid=,command=)
  return 1
}
for _ in $(seq 60); do
  ui_running || break
  sleep 1
done

mkdir -p "$STALE_DIR"
# Sweep bundles parked by earlier updates, minus the one a surviving daemon is
# still executing from — its argv still reads the old path, so only lsof knows.
LIVE="$(lsof -p "$(cat "$HOME/.odin/terminal-host.pid" 2>/dev/null || echo 0)" -Fn 2>/dev/null |
  grep -m1 -oE "$STALE_DIR/Odin-[0-9]+\\.app" || true)"
for old in "$STALE_DIR"/Odin-*.app; do
  [ -d "$old" ] && [ "$old" != "$LIVE" ] && rm -rf "$old"
done

# Park the old bundle instead of deleting it: a daemon kept alive across the
# update goes on running from that inode, so open sessions survive. A protocol
# bump is handled by the new app, which shuts the legacy daemon down and
# respawns it (terminal-host/client.ts).
# ditto MERGES into an existing bundle rather than replacing it, so a failed
# move must stop here — a half-old, half-new Odin.app is worse than no update.
STALE="$STALE_DIR/Odin-$(date +%s).app"
if [ -d "$APP" ] && ! mv "$APP" "$STALE"; then
  echo "[$(date '+%H:%M:%S')] could not move the installed bundle aside — aborting"
  exit 1
fi
if ditto "$MNT/Odin.app" "$APP"; then
  xattr -dr com.apple.quarantine "$APP" >/dev/null 2>&1 || true
  echo "[$(date '+%H:%M:%S')] installed; previous bundle parked at $STALE"
else
  echo "[$(date '+%H:%M:%S')] INSTALL FAILED — restoring the previous bundle"
  rm -rf "$APP"
  [ -d "$STALE" ] && mv "$STALE" "$APP"
fi
hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true
rm -rf "$WORK"
open -a "$APP"
echo "[$(date '+%H:%M:%S')] === done ==="`;
}
