#!/bin/bash
# Give this agent session its own checkout, cut from origin/main.
#
# Several Claude sessions run against this repo at once. They used to share one
# working tree, where `git checkout`, `git reset --hard` and `git stash` are
# global: one session's sync silently reverted another's uncommitted files. A
# worktree is a real directory per session, so nobody else's git command can
# touch your files.
#
# Usage: scripts/session-worktree.sh <name> [branch]      (branch defaults to <name>)
# Done:  git worktree remove .worktrees/<name>
set -euo pipefail

name="${1:?usage: scripts/session-worktree.sh <name> [branch]}"
branch="${2:-$name}"
root="$(git rev-parse --show-toplevel)"
wt="$root/.worktrees/$name"

cd "$root"
# Always cut from origin/main, never from whatever branch the repo is sitting
# on — that one is routinely dozens of commits stale and already squash-merged.
git fetch --quiet origin main
git worktree add --quiet -b "$branch" "$wt" origin/main

# Symlink the installed deps in. A fresh worktree has no node_modules, so
# `bun test` fails to resolve the workspace aliases (@odin/shared/*) and tsc
# reports a wall of bogus errors. Discovered rather than listed, so a new
# package doesn't silently go missing.
while read -r d; do
	[ -e "$wt/$d/node_modules" ] || ln -s "$root/$d/node_modules" "$wt/$d/node_modules"
done < <(git -C "$root" rev-parse --show-toplevel >/dev/null && \
	find "$root" -maxdepth 3 -name node_modules -type d -not -path "$root/.worktrees/*" \
	-exec dirname {} \; | sed "s|^$root/\{0,1\}||;s|^$|.|")

echo "$wt"
