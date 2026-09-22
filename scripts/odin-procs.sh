#!/usr/bin/env bash
# Shared process handling for the Odin scripts. Sourced, not executed.
#
# The packaged UI and the terminal-host daemon run the SAME argv[0] — the app's
# own Electron binary, re-executed with ELECTRON_RUN_AS_NODE — so any pattern
# matching the bundle path hits both. Killing the daemon closes every open
# terminal session, which is exactly what these helpers exist to avoid: the
# daemon is spawned detached on purpose, and dev and packaged builds share
# ~/.odin, so a surviving daemon is adopted by whichever Odin starts next.
#
#   source "$REPO/scripts/odin-procs.sh"

# Enumerate with ps, NOT `pgrep -f`. pgrep silently skips processes whose
# executable has been moved out from under them — measured here: after a bundle
# rename it reported 3 of the 6 processes ps listed, and the one it dropped was
# the daemon. That's the one state where being wrong is destructive, since these
# helpers gate an `rm -rf` of the bundle a live daemon is still running from.
odin_procs() { ps ax -o pid=,command= | grep -F "$1" | grep -vw grep; }

# The daemon records its own pid, which stays authoritative even when argv
# matching can't see it.
daemon_pid_file() { cat "$HOME/.odin/terminal-host.pid" 2>/dev/null; }

# Only the daemon carries the daemon script in argv[1]; that's the tell.
daemon_pids() {
  {
    odin_procs "Applications/Odin.app" | grep -F "terminal-host.js" |
      awk '{print $1}'
    daemon_pid_file
  } | sort -u
}

# Packaged UI processes, never the daemon.
ui_pids() {
  local daemons pid
  daemons=" $(daemon_pids | tr '\n' ' ') "
  for pid in $(odin_procs "Applications/Odin.app/Contents/MacOS/Odin" |
    awk '{print $1}'); do
    [[ "$daemons" == *" $pid "* ]] || printf '%s\n' "$pid"
  done
}

# Quit the packaged Odin, leaving its daemon (and so its sessions) running.
quit_packaged_ui() {
  [[ -n "$(ui_pids)" ]] || return 0
  osascript -e 'quit app "Odin"' >/dev/null 2>&1 || true
  for _ in $(seq 1 15); do
    [[ -z "$(ui_pids)" ]] && break
    sleep 1
  done
  local pid
  for pid in $(ui_pids); do kill -9 "$pid" 2>/dev/null || true; done
  sleep 2
}

# Live dev stacks, one "<pid> <repo>" line each. odin-dev.sh runs `bun dev` in a
# pipeline and so stays alive for the whole session — its presence IS the
# session, booting or already up, which is why it's the thing counted rather
# than the UI (absent for the 17s–2min a start takes).
dev_stack_lines() {
  odin_procs "scripts/odin-dev.sh" |
    awk '{ for (i = 2; i <= NF; i++)
             if ($i ~ /scripts\/odin-dev\.sh$/) {
               sub(/\/scripts\/odin-dev\.sh$/, "", $i)
               print $1, $i
               break
             } }'
}

# Stop one checkout's dev runners. Only the runners are matched by pattern:
# every OTHER Electron under a checkout is the terminal-host daemon or a live
# session running the same binary from the same node_modules, so killing by
# path closes real sessions.
stop_dev_runners() {
  pkill -f "$1.*electron-vite dev" 2>/dev/null && sleep 2
  pkill -f "$1.*turbo run dev" 2>/dev/null
  return 0
}
