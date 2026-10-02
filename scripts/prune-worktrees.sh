#!/bin/bash
# Remove session worktrees whose work already landed on origin/main.
#
# Every agent session takes a worktree (session-worktree.sh), each a full
# `bun install` at ~3GB, and nobody removes them once the PR merges — fifteen
# filled the disk. This removes the ones with nothing left to lose:
#
#   - its work landed: every file the branch changed is identical on
#     origin/main, or its PR is merged and HEAD is that PR's head, so nothing
#     was committed after. PRs are squash-merged, so `merge-base --is-ancestor`
#     says "not merged" for work that did land. Content alone keeps any branch
#     whose files main has touched since; the PR answer (needs `gh`, signed
#     in or given $GH_TOKEN; skipped without it) covers those.
#   - nothing uncommitted: plain `git worktree remove` refuses a dirty or
#     untracked tree, so it is the dirty check. Gitignored output (node_modules,
#     dist) doesn't count and goes with it.
#   - untouched for $PRUNE_MIN_AGE_HOURS (default 24): a fresh worktree has no
#     commits yet either, and its session may be about to write. Work that
#     already landed only waits $PRUNE_LANDED_MIN_AGE_HOURS (default 1) — at a
#     dozen merges a day, a full day's grace kept ~35GB of finished worktrees
#     on disk and filled it.
#
# Usage: scripts/prune-worktrees.sh [--dry-run] [repo]     (repo defaults to this one)
set -euo pipefail

dry=0
if [ "${1:-}" = "--dry-run" ]; then dry=1; shift; fi
root="$(git -C "${1:-$(dirname "$0")}" rev-parse --show-toplevel)"
min_age=$(( ${PRUNE_MIN_AGE_HOURS:-24} * 3600 ))
landed_min_age=$(( ${PRUNE_LANDED_MIN_AGE_HOURS:-1} * 3600 ))
now=$(date +%s)

git -C "$root" fetch --quiet origin main
repo="$(git -C "$root" remote get-url origin | sed -E 's#^(git@|https://)github.com[:/]##; s#\.git$##')"

# Did this branch's PR merge with exactly this commit as its head?
merged_at_head() { # merged_at_head <branch> <sha>
	command -v gh >/dev/null || return 1
	[ "$(gh pr list -R "$repo" --head "$1" --state merged --json headRefOid -q '.[].headRefOid' 2>/dev/null)" = "$2" ]
}

git -C "$root" worktree list --porcelain | sed -n 's/^worktree //p' | while read -r wt; do
	case "$wt" in "$root/.worktrees/"*) ;; *) continue ;; esac
	name="${wt#"$root/.worktrees/"}"

	# The newest of: last commit or checkout here, last write to its index.
	gitdir="$(git -C "$wt" rev-parse --absolute-git-dir)"
	touched=$(stat -f %m "$gitdir/index" "$gitdir/logs/HEAD" "$gitdir/HEAD" 2>/dev/null | sort -n | tail -1)
	age=$(( now - ${touched:-$now} ))
	if [ "$age" -lt "$landed_min_age" ]; then
		echo "keep   $name (touched in the last $(( landed_min_age / 3600 ))h)"
		continue
	fi

	base="$(git -C "$wt" merge-base HEAD origin/main)"
	files=()
	while IFS= read -r file; do files+=("$file"); done < <(git -C "$wt" diff --name-only "$base" HEAD)
	# Any error from diff (not just "differs") keeps the worktree.
	if [ ${#files[@]} -gt 0 ] &&
		! git -C "$wt" diff --quiet origin/main HEAD -- "${files[@]}" &&
		! merged_at_head "$(git -C "$wt" branch --show-current)" "$(git -C "$wt" rev-parse HEAD)"; then
		echo "keep   $name (has changes not on origin/main)"
		continue
	fi
	# No commits of its own yet is not "landed" — that's a session just starting.
	if [ ${#files[@]} -eq 0 ] && [ "$age" -lt "$min_age" ]; then
		echo "keep   $name (touched in the last $(( min_age / 3600 ))h)"
		continue
	fi

	# Checked up front too, so --dry-run reports what a real run would do.
	if [ -n "$(git -C "$wt" status --porcelain)" ]; then
		echo "keep   $name (uncommitted or untracked files)"
		continue
	fi

	if [ "$dry" = 1 ]; then
		echo "remove $name (dry run)"
	elif git -C "$root" worktree remove "$wt" 2>/dev/null; then
		echo "remove $name"
	else
		echo "keep   $name (uncommitted or untracked files)"
	fi
done

[ "$dry" = 1 ] || git -C "$root" worktree prune
