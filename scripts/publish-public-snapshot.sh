#!/bin/bash
# Republishes github.com/danlinenberg/odin — the public mirror — as a single
# commit holding exactly this repo's `main`, with no history behind it.
#
# ponytail: force-push, one commit, every time. The mirror is a publication, not
# a branch: nothing is ever merged back, so there is nothing to preserve.
set -euo pipefail

PUBLIC_URL="https://github.com/danlinenberg/odin.git"

# Every git call below talks to GitHub as the personal account. The configured
# helper answers first with whichever account git saw last, and that one can
# reach neither repo — so clear the list (KEY_0) before naming this one (KEY_1).
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=credential.helper
export GIT_CONFIG_VALUE_1='!f() { echo username=danlinenberg; echo "password=$(gh auth token --user danlinenberg)"; }; f'
REF="${1:-origin/main}"
repo_git=$(git rev-parse --absolute-git-dir)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git fetch --quiet origin main
git archive "$REF" | tar -x -C "$work"

cd "$work"
git init --quiet -b main
# -f because the checked-out .gitignore matches files that are tracked upstream
# (.env.example is caught by `.env.*`) — without it they vanish from the mirror.
git add -Af
git commit --quiet -F - <<'MSG'
Odin

A personal work console for delegating to coding agents: one queue across
Slack, Jira, GitHub and Notion, a board over live agent state, and briefs for
picking work back up.

Published as a snapshot of the development repo — the history before this
commit is not part of the public tree. Odin is a fork of Superset
(https://github.com/superset-sh/superset) and carries its Elastic License 2.0.
MSG

# The mirror must be byte-identical to what was published, or something was
# dropped on the way out.
snapshot=$(git rev-parse HEAD^{tree})
expected=$(git --git-dir="$repo_git" rev-parse "$REF^{tree}")
if [[ "$snapshot" != "$expected" ]]; then
	echo "snapshot tree $snapshot != $REF tree $expected" >&2
	exit 1
fi

git push --force --quiet "$PUBLIC_URL" main
echo "Published $REF ($(git rev-parse --short HEAD)) to $PUBLIC_URL"
