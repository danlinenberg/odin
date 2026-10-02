#!/usr/bin/env bash
# Self-check for prune-worktrees.sh: it removes landed work and keeps the rest.
#
# Builds a throwaway repo with an origin and four worktrees — one squash-landed,
# one with a commit main doesn't have, one dirty, one fresh — and checks which
# survive. No gh here, so this covers the content rule only.
#
#   scripts/prune-worktrees.test.sh
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAIL=0
check() { # check <description> <condition-exit-code>
	if [ "$2" -eq 0 ]; then echo "  ok   $1"; else echo "  FAIL $1"; FAIL=1; fi
}
g() { git -c user.email=t@t -c user.name=t "$@" >/dev/null 2>&1; }

g init -q --bare -b main "$TMP/origin.git"
g clone -q "$TMP/origin.git" "$TMP/repo"
cd "$TMP/repo" || exit 1
echo a >a && g add a && g commit -qm init && g push -q origin main
for wt in landed unique dirty; do
	g worktree add -q -b "$wt" ".worktrees/$wt" origin/main
done
echo landed >.worktrees/landed/b && g -C .worktrees/landed add b && g -C .worktrees/landed commit -qm b
# The squash of "landed" onto main: same content, different commit.
echo landed >b && g add b && g commit -qm "squash b" && g push -q origin main
echo mine >.worktrees/unique/c && g -C .worktrees/unique add c && g -C .worktrees/unique commit -qm c
echo scratch >.worktrees/dirty/notes.txt

! PRUNE_MIN_AGE_HOURS=0 PRUNE_LANDED_MIN_AGE_HOURS=0 GH_TOKEN= "$DIR/prune-worktrees.sh" --dry-run "$TMP/repo" | grep -q "^remove dirty"
check "dry run keeps a worktree with untracked files" $?

PRUNE_MIN_AGE_HOURS=0 PRUNE_LANDED_MIN_AGE_HOURS=0 GH_TOKEN= "$DIR/prune-worktrees.sh" "$TMP/repo" >/dev/null
[ ! -d .worktrees/landed ]
check "removes a worktree whose change is already on origin/main" $?
[ -d .worktrees/unique ]
check "keeps a worktree with a commit main doesn't have" $?
[ -d .worktrees/dirty ]
check "keeps a worktree with untracked files" $?

g worktree add -q -b fresh .worktrees/fresh origin/main
PRUNE_MIN_AGE_HOURS=24 GH_TOKEN= "$DIR/prune-worktrees.sh" "$TMP/repo" >/dev/null
[ -d .worktrees/fresh ]
check "keeps a worktree touched within the age window" $?

# Landed an hour ago: gone, despite the 24h window. Fresh and empty: kept.
g worktree add -q -b recent .worktrees/recent origin/main
echo recent >.worktrees/recent/d && g -C .worktrees/recent add d && g -C .worktrees/recent commit -qm d
echo recent >d && g add d && g commit -qm "squash d" && g push -q origin main
PRUNE_MIN_AGE_HOURS=24 PRUNE_LANDED_MIN_AGE_HOURS=0 GH_TOKEN= "$DIR/prune-worktrees.sh" "$TMP/repo" >/dev/null
[ ! -d .worktrees/recent ]
check "removes landed work after the short window, not the 24h one" $?
[ -d .worktrees/fresh ]
check "still keeps a fresh worktree with no commits for 24h" $?

exit $FAIL
