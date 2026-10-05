#!/bin/bash
# Remove session worktrees whose work already landed on the default branch.
#
# Every agent session takes a worktree (session-worktree.sh), each a full
# `bun install` at ~3GB, and nobody removes them once the PR merges - fifteen
# filled the disk. This removes the ones with nothing left to lose:
#
#   - its work landed: every file the branch changed is identical on
#     origin/main, or its PR is merged or closed and HEAD is that PR's head, so
#     nothing was committed after - a closed PR's branch is still on GitHub. PRs are squash-merged, so `merge-base --is-ancestor`
#     says "not merged" for work that did land. Content alone keeps any branch
#     whose files main has touched since; the PR answer (needs `gh`: $GH_TOKEN,
#     then every signed-in account; skipped without it) covers those.
#   - nothing uncommitted: plain `git worktree remove` refuses a dirty or
#     untracked tree, so it is the dirty check. Gitignored output (node_modules,
#     dist) doesn't count and goes with it. A landed tree left dirty for
#     $PRUNE_DIRTY_MIN_AGE_DAYS (default 7) goes too, after its files are
#     committed to refs/pruned/<name>: `git checkout refs/pruned/<name> -- .`
#     brings them back.
#   - untouched for $PRUNE_MIN_AGE_HOURS (default 24): a fresh worktree has no
#     commits yet either, and its session may be about to write. Work that
#     already landed only waits $PRUNE_LANDED_MIN_AGE_HOURS (default 1) - at a
#     dozen merges a day, a full day's grace kept ~35GB of finished worktrees
#     on disk and filled it.
#
# Usage: scripts/prune-worktrees.sh [--dry-run] [repo]     (repo defaults to this one)
# Any repo: worktrees under <repo>/.worktrees/, against its own default branch.
set -euo pipefail

dry=0
if [ "${1:-}" = "--dry-run" ]; then dry=1; shift; fi
root="$(git -C "${1:-$(dirname "$0")}" rev-parse --show-toplevel)"
min_age=$(( ${PRUNE_MIN_AGE_HOURS:-24} * 3600 ))
landed_min_age=$(( ${PRUNE_LANDED_MIN_AGE_HOURS:-1} * 3600 ))
dirty_min_age=$(( ${PRUNE_DIRTY_MIN_AGE_DAYS:-7} * 86400 ))
now=$(date +%s)

main="$(git -C "$root" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"
main="${main#origin/}"
git -C "$root" fetch --quiet origin "$main"
repo="$(git -C "$root" remote get-url origin | sed -E 's#^(git@|https://)github.com[:/]##; s#\.git$##')"

# Did this branch's PR merge or close with exactly this commit as its head?
# Tried as $GH_TOKEN, then as each signed-in account: a work repo 404s for the
# personal one.
ended_at_head() { # ended_at_head <branch> <sha>
	command -v gh >/dev/null || return 1
	local heads account
	heads="$(gh pr list -R "$repo" --head "$1" --state closed --json headRefOid -q '.[].headRefOid' 2>/dev/null)" ||
		for account in $(gh auth status 2>&1 | sed -n 's/.*Logged in to [^ ]* account \([^ ]*\).*/\1/p'); do
			heads="$(GH_TOKEN="$(gh auth token --user "$account")" gh pr list -R "$repo" --head "$1" --state closed --json headRefOid -q '.[].headRefOid' 2>/dev/null)" && break
		done
	grep -qx "$2" <<<"$heads"
}

git -C "$root" worktree list --porcelain | sed -n 's/^worktree //p' | while read -r wt; do
	case "$wt" in "$root/.worktrees/"*) ;; *) continue ;; esac
	name="${wt#"$root/.worktrees/"}"

	# The newest of: last commit or checkout here, last write to its index.
	# The reflog's own timestamp, not its mtime: gc's `reflog expire` rewrites
	# every worktree's reflog at once, so the mtime kept all of them "fresh".
	gitdir="$(git -C "$wt" rev-parse --absolute-git-dir)"
	touched=$( {
		stat -f %m "$gitdir/index" "$gitdir/HEAD" 2>/dev/null
		tail -1 "$gitdir/logs/HEAD" 2>/dev/null | cut -f1 | awk '{print $(NF-1)}'
	} | sort -n | tail -1)
	age=$(( now - ${touched:-$now} ))
	if [ "$age" -lt "$landed_min_age" ]; then
		echo "keep   $name (touched in the last $(( landed_min_age / 3600 ))h)"
		continue
	fi

	base="$(git -C "$wt" merge-base HEAD "origin/$main")"
	files=()
	while IFS= read -r file; do files+=("$file"); done < <(git -C "$wt" diff --name-only "$base" HEAD)
	# Any error from diff (not just "differs") keeps the worktree.
	if [ ${#files[@]} -gt 0 ] &&
		! git -C "$wt" diff --quiet "origin/$main" HEAD -- "${files[@]}" &&
		! ended_at_head "$(git -C "$wt" branch --show-current)" "$(git -C "$wt" rev-parse HEAD)"; then
		echo "keep   $name (has changes not on origin/$main)"
		continue
	fi
	# No commits of its own yet is not "landed" - that's a session just starting.
	if [ ${#files[@]} -eq 0 ] && [ "$age" -lt "$min_age" ]; then
		echo "keep   $name (touched in the last $(( min_age / 3600 ))h)"
		continue
	fi

	# Checked up front too, so --dry-run reports what a real run would do.
	if [ -n "$(git -C "$wt" status --porcelain)" ]; then
		# Editing a file touches no git state, so the files' own mtimes count too.
		edited=$(git -C "$wt" ls-files -z --modified --others --exclude-standard |
			(cd "$wt" && xargs -0 stat -f %m 2>/dev/null) | sort -n | tail -1)
		if [ "$age" -lt "$dirty_min_age" ] || [ $(( now - ${edited:-0} )) -lt "$dirty_min_age" ]; then
			echo "keep   $name (uncommitted or untracked files)"
		elif [ "$dry" = 1 ]; then
			echo "remove $name (dry run, files saved to refs/pruned/$name)"
		else
			# A throwaway index, so the worktree's own staging is left as it was.
			# ponytail: an untracked multi-GB file lands in the repo's objects too;
			# skip on size if that ever happens.
			index="$(mktemp)"
			GIT_INDEX_FILE="$index" git -C "$wt" read-tree HEAD
			GIT_INDEX_FILE="$index" git -C "$wt" add -A
			snapshot="$(git -C "$wt" -c user.name=odin -c user.email=odin@localhost commit-tree "$(GIT_INDEX_FILE="$index" git -C "$wt" write-tree)" -p HEAD -m "pruned worktree $name")"
			rm -f "$index"
			git -C "$root" update-ref "refs/pruned/$name" "$snapshot"
			git -C "$root" worktree remove --force "$wt"
			echo "remove $name (files saved to refs/pruned/$name)"
		fi
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
