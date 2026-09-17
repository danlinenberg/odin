#!/usr/bin/env bash
# Self-check for session-worktree.sh's two silent-failure modes.
#
# Both fail by producing a worktree that looks fine and isn't: a branch cut from
# the local (stale) HEAD instead of origin/main, and a missing node_modules
# symlink that only shows up later as an unresolvable @odin/* import. Neither
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

# Every package that has deps installed in the main checkout must have them here.
missing=0
while read -r d; do
	[ -e "$WT/$d/node_modules" ] || { echo "    missing: $d/node_modules"; missing=1; }
done < <(find "$ROOT" -maxdepth 3 -name node_modules -type d -not -path "$ROOT/.worktrees/*" \
	-exec dirname {} \; | sed "s|^$ROOT/\{0,1\}||;s|^$|.|")
check "node_modules symlinked for every installed package" $missing

(cd "$WT/apps/desktop" && bun test src/shared/odin-tags.test.ts >/dev/null 2>&1)
check "bun test resolves workspace aliases in the worktree" $?

exit $FAIL
