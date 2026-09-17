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

# Install for real rather than symlinking the main checkout's node_modules in.
# The workspace links under apps/desktop/node_modules/@odin are relative
# (../../../../packages/shared), so a symlinked node_modules resolves them from
# its physical home — the main checkout. Edits to packages/* in the worktree
# then build against the wrong copy, silently when the exports happen to line
# up. ~20s with a warm cache buys correctness.
(cd "$wt" && bun install --frozen-lockfile >/dev/null)

echo "$wt"
