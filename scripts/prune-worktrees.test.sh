#!/usr/bin/env bash
# Self-check for prune-worktrees.sh: it removes landed work and keeps the rest.
#
# Builds a throwaway repo with an origin and four worktrees - one squash-landed,
# one with a commit main doesn't have, one dirty, one fresh - and checks which
# survive. A fake gh at the end covers the closed-PR rule.
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

# --only: one landed worktree goes, another landed one stays for the next pass.
for wt in one two; do
	g worktree add -q -b "$wt" ".worktrees/$wt" origin/main
	echo "$wt" >".worktrees/$wt/$wt" && g -C ".worktrees/$wt" add "$wt" && g -C ".worktrees/$wt" commit -qm "$wt"
	echo "$wt" >"$wt" && g add "$wt" && g commit -qm "squash $wt" && g push -q origin main
done
PRUNE_LANDED_MIN_AGE_HOURS=0 GH_TOKEN= "$DIR/prune-worktrees.sh" --only one "$TMP/repo" >/dev/null
[ ! -d .worktrees/one ] && [ -d .worktrees/two ]
check "--only removes just that worktree" $?
! PRUNE_LANDED_MIN_AGE_HOURS=0 GH_TOKEN= "$DIR/prune-worktrees.sh" --only unique "$TMP/repo" | grep -q "^remove"
check "--only still keeps work main doesn't have" $?

# Closed PR at exactly the worktree's head: gone, even though main moved the
# same file on. Closed at another commit: kept. The fake gh answers the one
# GraphQL query with "<branch> <head sha>" lines.
mkdir -p "$TMP/bin"
printf '#!/bin/sh\n[ "$1" = api ] && cat "%s/closed"\n' "$TMP" >"$TMP/bin/gh" && chmod +x "$TMP/bin/gh"
for wt in merged moved; do
	g worktree add -q -b "$wt" ".worktrees/$wt" origin/main
	echo "pr $wt" >".worktrees/$wt/e-$wt" && g -C ".worktrees/$wt" add "e-$wt" && g -C ".worktrees/$wt" commit -qm "$wt"
	echo "later" >"e-$wt" && g add "e-$wt" && g commit -qm "main moves e-$wt on" && g push -q origin main
done
{
	echo "merged $(git -C .worktrees/merged rev-parse HEAD)"
	echo "moved 0000000000000000000000000000000000000000"
} >"$TMP/closed"
PATH="$TMP/bin:$PATH" PRUNE_LANDED_MIN_AGE_HOURS=0 "$DIR/prune-worktrees.sh" "$TMP/repo" >/dev/null
[ ! -d .worktrees/merged ]
check "removes a worktree whose PR closed at its head" $?
[ -d .worktrees/moved ]
check "keeps a worktree whose PR closed at another commit" $?

exit $FAIL
