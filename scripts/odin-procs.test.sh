#!/usr/bin/env bash
# Self-check for odin-procs.sh's UI/daemon split.
#
# The packaged UI and the terminal-host daemon run the SAME argv[0], so the only
# thing telling them apart is the daemon script in argv[1]. Getting this wrong
# kills the daemon and closes every open session — and in odin-update.sh it also
# gates an `rm -rf` of the bundle a live daemon is running from — so it gets a
# check. The two I/O boundaries (ps, the pid file) are stubbed; everything else
# is the real code.
#
#   scripts/odin-procs.test.sh
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/odin-procs.sh
source "$DIR/odin-procs.sh"

fail() {
  echo "FAIL: $*"
  exit 1
}

UI_LINE="101 /Applications/Odin.app/Contents/MacOS/Odin"
DAEMON_LINE="202 /Applications/Odin.app/Contents/MacOS/Odin /Applications/Odin.app/Contents/Resources/app.asar/dist/main/terminal-host.js"

# Both really do contain the bundle path, so the stub ignores the pattern and
# lets the real filtering do the work.
odin_procs() { printf '%s\n%s\n' "$UI_LINE" "$DAEMON_LINE"; }
daemon_pid_file() { :; }

got="$(ui_pids | tr '\n' ' ')"
[[ "$got" == "101 " ]] || fail "ui_pids returned '$got', want '101 '"
got="$(daemon_pids | tr '\n' ' ')"
[[ "$got" == "202 " ]] || fail "daemon_pids returned '$got', want '202 '"

# The pid file is authoritative even when ps can't see the daemon at all — the
# renamed-bundle case that made pgrep unusable in the first place.
odin_procs() { printf '%s\n' "$UI_LINE"; }
daemon_pid_file() { printf '303\n'; }
got="$(daemon_pids | tr '\n' ' ')"
[[ "$got" == "303 " ]] || fail "daemon_pids ignored the pid file: got '$got', want '303 '"

# ...and a UI pid that the pid file claims is the daemon must not be killed.
odin_procs() { printf '%s\n' "$UI_LINE"; }
daemon_pid_file() { printf '101\n'; }
got="$(ui_pids | tr '\n' ' ')"
[[ -z "${got// /}" ]] || fail "ui_pids returned '$got' for a pid the pid file claims, want empty"

# Nothing running at all.
odin_procs() { :; }
daemon_pid_file() { :; }
got="$(ui_pids | tr '\n' ' ')"
[[ -z "${got// /}" ]] || fail "ui_pids returned '$got' with no processes, want empty"

# dev_stack_lines feeds odin-dev.sh's one-session guard, which compares the repo
# it parses here against its own $REPO — a mis-parse either refuses a legitimate
# restart or lets a second session through. Both argv shapes occur: the in-app
# Restart spawns `/bin/bash <repo>/scripts/odin-dev.sh`, a shell or the Raycast
# hotkey runs the script directly.
odin_procs() {
  printf '%s\n%s\n' \
    " 404 /bin/bash /Users/x/odin/scripts/odin-dev.sh" \
    " 505 /Users/x/odin/.worktrees/foo/scripts/odin-dev.sh"
}
got="$(dev_stack_lines | tr '\n' '|')"
want="404 /Users/x/odin|505 /Users/x/odin/.worktrees/foo|"
[[ "$got" == "$want" ]] || fail "dev_stack_lines returned '$got', want '$want'"

odin_procs() { :; }
got="$(dev_stack_lines)"
[[ -z "$got" ]] || fail "dev_stack_lines returned '$got' with no dev stack, want empty"

echo "PASS: UI/daemon split holds via ps and the pid file"
echo "PASS: dev_stack_lines reports one <pid> <repo> per live dev session"
