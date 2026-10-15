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
#   - nothing uncommitted: `git status --porcelain` is empty. Gitignored output (node_modules,
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
# Usage: scripts/prune-worktrees.sh [--dry-run] [--only <name>] [repo]     (repo defaults to this one)
# A worktree's name is its folder under <repo>/.worktrees/, or its absolute
# path when it lives anywhere else (.wt/, a sibling folder, ~/.superset/...).
# --only checks just that one, by the same rules (Settings -> Storage).
# --only <name> --force removes it whatever it holds (Settings -> Storage, after
# a warning): its branch stays, and uncommitted files go to refs/pruned/<ref>,
# <ref> being the name with its leading / dropped, other characters git refuses
# made a dash, and a "." that starts a folder name written "_.".
# Any repo: every linked worktree, against the repo's own default branch.
# Locked ones are left alone.
set -euo pipefail

dry=0
only=""
force=0
while :; do
	case "${1:-}" in
	--dry-run) dry=1; shift ;;
	--only) only="$2"; shift 2 ;;
	--force) force=1; shift ;;
	*) break ;;
	esac
done
if [ "$force" = 1 ] && [ -z "$only" ]; then
	echo "--force needs --only <name>: it never sweeps a whole repo" >&2
	exit 2
fi
root="$(git -C "${1:-$(dirname "$0")}" rev-parse --show-toplevel)"
min_age=$(( ${PRUNE_MIN_AGE_HOURS:-24} * 3600 ))
landed_min_age=$(( ${PRUNE_LANDED_MIN_AGE_HOURS:-1} * 3600 ))
dirty_min_age=$(( ${PRUNE_DIRTY_MIN_AGE_DAYS:-7} * 86400 ))
now=$(date +%s)

main="$(git -C "$root" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"
main="${main#origin/}"
# --only comes from Settings → Storage, whose list fetched a moment ago: one
# fetch per deleted worktree made deleting 78 of them take minutes.
if [ -z "$only" ]; then
	# As gh's credential helper's token ($GH_TOKEN), then as each signed-in
	# account: a personal private repo is "not found" to the work token.
	git -C "$root" fetch --quiet origin "$main" 2>/dev/null || {
		fetched=0
		for account in $(gh auth status 2>&1 | sed -n 's/.*Logged in to [^ ]* account \([^ ]*\).*/\1/p'); do
			GH_TOKEN="$(gh auth token --user "$account")" git -C "$root" fetch --quiet origin "$main" 2>/dev/null && { fetched=1; break; }
		done
		[ "$fetched" = 1 ] || git -C "$root" fetch --quiet origin "$main"
	}
fi
repo="$(git -C "$root" remote get-url origin | sed -E 's#^(git@|https://)github.com[:/]##; s#\.git$##')"

# Did this branch's PR merge or close with exactly this commit as its head?
# One GraphQL query per run for every worktree branch, not one `gh pr list`
# per worktree: a repo with 17 worktrees took 35s, and every 10 minutes the
# calls ate the account's GraphQL limit. Tried as $GH_TOKEN, then as each
# signed-in account: a work repo 404s for the personal one.
closed_heads=""
closed_heads_read=0
read_closed_heads() {
	local query="" i=0 branch account
	while read -r branch; do
		query+="b$i: pullRequests(headRefName: \"$branch\", states: [MERGED, CLOSED], first: 20) { nodes { headRefName headRefOid } } "
		i=$((i + 1))
	done < <(git -C "$root" worktree list --porcelain | sed -n 's#^branch refs/heads/##p')
	[ "$i" = 0 ] && return 0
	local args=(api graphql -f owner="${repo%%/*}" -f name="${repo#*/}" -f query="query(\$owner: String!, \$name: String!) { repository(owner: \$owner, name: \$name) { $query } }" -q '.data.repository[].nodes[] | .headRefName + " " + .headRefOid')
	# A failed call still prints its error JSON, so only a success is echoed.
	local out
	out="$(gh "${args[@]}" 2>/dev/null)" && { echo "$out"; return; }
	for account in $(gh auth status 2>&1 | sed -n 's/.*Logged in to [^ ]* account \([^ ]*\).*/\1/p'); do
		out="$(GH_TOKEN="$(gh auth token --user "$account")" gh "${args[@]}" 2>/dev/null)" && { echo "$out"; return; }
	done
}
ended_at_head() { # ended_at_head <branch> <sha>
	command -v gh >/dev/null || return 1
	if [ "$closed_heads_read" = 0 ]; then
		closed_heads_read=1
		closed_heads="$(read_closed_heads)"
	fi
	grep -qxF "$1 $2" <<<"$closed_heads"
}

# Commit a worktree's uncommitted files to refs/pruned/<name>, so removing it
# loses nothing: `git checkout refs/pruned/<name> -- .` brings them back.
pruned_ref() { # pruned_ref <name> - a path keeps its slashes, so two paths never share a ref
	echo "refs/pruned/$(sed -E 's#^/+##; s#[^A-Za-z0-9._/-]#-#g; s#(^|/)\.#\1_.#g' <<<"$1")"
}
save_files() { # save_files <worktree> <name>
	# A throwaway index, so the worktree's own staging is left as it was.
	# ponytail: an untracked multi-GB file lands in the repo's objects too;
	# skip on size if that ever happens.
	local index snapshot
	index="$(mktemp)"
	GIT_INDEX_FILE="$index" git -C "$1" read-tree HEAD
	GIT_INDEX_FILE="$index" git -C "$1" add -A
	snapshot="$(git -C "$1" -c user.name=odin -c user.email=odin@localhost commit-tree "$(GIT_INDEX_FILE="$index" git -C "$1" write-tree)" -p HEAD -m "pruned worktree $2")"
	rm -f "$index"
	git -C "$root" update-ref "$(pruned_ref "$2")" "$snapshot"
}

# Move the worktree aside and delete it in the background: git removes a 3 GB
# install file by file, and Storage waited on each one. Same disk, so the move
# is instant; git forgets the worktree at once, the space frees a little later.
fast_remove() { # fast_remove <worktree> <name>
	# In .git/, where the leftover sweep below looks and git status never does,
	# unless that is another disk: there mv would copy, so it goes beside the worktree.
	local trash="$root/.git/odin-trash-$(basename "$1")-$$"
	[ "$(stat -f %d "$1")" = "$(stat -f %d "$root/.git")" ] ||
		trash="$(dirname "$1")/.trash-$(basename "$1")-$$"
	mv "$1" "$trash"
	git -C "$root" worktree prune
	nohup rm -rf "$trash" >/dev/null 2>&1 &
}
# Leftovers from a run that was killed before its rm finished.
for leftover in "$root"/.git/odin-trash-* "$root"/.worktrees/.trash-*; do
	[ -e "$leftover" ] && [ "$dry" = 0 ] && { nohup rm -rf "$leftover" >/dev/null 2>&1 & }
done

# "<path>\t<locked>" per linked worktree; the first entry is the repo itself.
git -C "$root" worktree list --porcelain |
	awk '/^worktree /{if (p) print p "\t" l; p = substr($0, 10); l = 0} /^locked/{l = 1} END{if (p) print p "\t" l}' |
	tail -n +2 | while IFS=$'\t' read -r wt locked; do
	[ -d "$wt" ] || continue
	case "$wt" in "$root/.worktrees/"*) name="${wt#"$root/.worktrees/"}" ;; *) name="$wt" ;; esac
	[ -n "$only" ] && [ "$name" != "$only" ] && continue
	if [ "$locked" = 1 ]; then
		echo "keep   $name (locked)"
		continue
	fi

	if [ "$force" = 1 ]; then
		if [ "$dry" = 1 ]; then
			echo "remove $name (dry run, forced)"
		else
			[ -z "$(git -C "$wt" status --porcelain)" ] || save_files "$wt" "$name"
			fast_remove "$wt" "$name"
			echo "remove $name (forced; branch kept)"
		fi
		continue
	fi

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
		# A deleted file has none: stat fails on it, and pipefail must not end the run.
		edited=$(git -C "$wt" ls-files -z --modified --others --exclude-standard |
			(cd "$wt" && xargs -0 stat -f %m 2>/dev/null || true) | sort -n | tail -1)
		if [ "$age" -lt "$dirty_min_age" ] || [ $(( now - ${edited:-0} )) -lt "$dirty_min_age" ]; then
			echo "keep   $name (uncommitted or untracked files)"
		elif [ "$dry" = 1 ]; then
			echo "remove $name (dry run, files saved to $(pruned_ref "$name"))"
		else
			save_files "$wt" "$name"
			fast_remove "$wt" "$name"
			echo "remove $name (files saved to $(pruned_ref "$name"))"
		fi
		continue
	fi

	if [ "$dry" = 1 ]; then
		echo "remove $name (dry run)"
	elif [ -z "$(git -C "$wt" status --porcelain)" ]; then
		fast_remove "$wt" "$name"
		echo "remove $name"
	else
		echo "keep   $name (uncommitted or untracked files)"
	fi
done

[ "$dry" = 1 ] || git -C "$root" worktree prune
