#!/usr/bin/env bash
# Self-check for session-worktree.sh's two silent-failure modes.
#
# Both fail by producing a worktree that looks fine and isn't: a branch cut from
# the local (stale) HEAD instead of origin/main, and @odin/* resolving back to
# the main checkout, which builds packages/* edits from the wrong copy. Neither
# errors at creation time, so the shape is checked here.
#
#   scripts/session-worktree.test.sh
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
NAME="selftest-$$"
FAIL=0

check() { # check <description> <condition-exit-code>
	if [ "$2" -eq 0 ]; then echo "  ok   $1"; else echo "  FAIL $1"; FAIL=1; fi
}

WT="$("$DIR/session-worktree.sh" "$NAME" "selftest/$NAME")" || { echo "script failed"; exit 1; }
trap 'git -C "$ROOT" worktree remove --force "$WT" 2>/dev/null; git -C "$ROOT" branch -D "selftest/$NAME" 2>/dev/null' EXIT

[ "$(git -C "$WT" rev-parse HEAD)" = "$(git -C "$ROOT" rev-parse origin/main)" ]
check "branch is cut from origin/main, not local HEAD" $?

# The check that matters: @odin/* must resolve inside the worktree. A symlinked
# node_modules points them back at the main checkout, so packages/* edits build
# the wrong source.
shared="$(cd "$WT/apps/desktop/node_modules/@odin" 2>/dev/null && cd "$(readlink shared)" && pwd)"
case "$shared" in "$WT"/*) ok=0 ;; *) ok=1; echo "    @odin/shared -> $shared" ;; esac
check "@odin/* resolves inside the worktree, not the main checkout" $ok

(cd "$WT/apps/desktop" && bun test src/shared/odin-tags.test.ts >/dev/null 2>&1)
check "bun test resolves workspace aliases in the worktree" $?

exit $FAIL
