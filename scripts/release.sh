#!/usr/bin/env bash
# Cut a release: bump the version, build the DMG on CI, and install it over
# /Applications/Odin.app.
#
#   scripts/release.sh               # patch bump (1.18.4 -> 1.18.5)
#   scripts/release.sh 1.19.0        # explicit version
#   scripts/release.sh --no-install  # publish it, stay on the build you have
#
# This is the brew path, and it is not scripts/odin-update.sh. That one rebuilds
# THIS checkout straight into /Applications for you alone; this one ships what is
# on main to everybody, through a GitHub Release the cask downloads from.
#
# Everything happens off origin/main in a throwaway worktree: the checkout you
# run it from is shared with other agents, and none of its state is read.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SLUG=danlinenberg/odin

# Every GitHub call goes out as the personal account. git's configured helper
# answers with whichever account it saw last, and that one cannot reach this
# repo — clear the list (KEY_0) before naming this one (KEY_1).
#
# KEY_2 is what makes the other two matter: `origin` is an SSH remote, and git
# never consults a credential helper for SSH. Reads succeed on the key alone,
# so this only shows up at the push — "Please make sure you have the correct
# access rights", from a key that resolves to the work account. Rewriting the
# remote to HTTPS for the length of this script puts the helper back in the
# path.
export GH_TOKEN="$(gh auth token --user danlinenberg)"
export GIT_CONFIG_COUNT=3
export GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=credential.helper
export GIT_CONFIG_VALUE_1='!f() { echo username=danlinenberg; echo "password=$(gh auth token --user danlinenberg)"; }; f'
export GIT_CONFIG_KEY_2='url.https://github.com/.insteadOf'
export GIT_CONFIG_VALUE_2='git@github.com:'

cd "$REPO"
git fetch --quiet origin main

# --no-install publishes the release without upgrading this machine onto it —
# which is how you get a version to test the app's own updater against.
INSTALL=1
if [[ "${1:-}" == "--no-install" ]]; then
	INSTALL=0
	shift
fi

# Bump from the latest release, not main's package.json: a manual Release run
# publishes the next patch without committing it, so main can lag behind.
OLD=$(gh release view --repo "$SLUG" --json tagName -q .tagName)
OLD=${OLD#v}
NEW="${1:-$(awk -F. '{print $1"."$2"."$3+1}' <<<"$OLD")}"
TAG="v$NEW"

# release.yml would fail on a taken version too, but only after a 10-minute
# build and a merged version bump — catch it here first.
if gh release view "$TAG" --repo "$SLUG" >/dev/null 2>&1; then
	echo "$TAG is already released — pass a version that is not taken" >&2
	exit 1
fi
echo "==> $OLD -> $NEW"

BRANCH="release/$NEW"
WORK=$(mktemp -d)
trap 'git worktree remove --force "$WORK/wt" 2>/dev/null || true
      git branch -D "$BRANCH" 2>/dev/null || true
      rm -rf "$WORK"' EXIT
git worktree add --quiet -b "$BRANCH" "$WORK/wt" origin/main

# desktop and host-service have shared a version since the fork, and bun.lock
# records both — CI installs with --frozen-lockfile, so a stale lock fails the
# build before it starts. The anchor is the one tab-indented "version" line, so
# no dependency's pinned version is touched.
cd "$WORK/wt"
sed -i '' "s/^\(	\"version\": \)\"[^\"]*\"/\1\"$NEW\"/" \
	apps/desktop/package.json packages/host-service/package.json
bun install --lockfile-only
git add apps/desktop/package.json packages/host-service/package.json bun.lock
git commit --quiet -m "Odin $NEW"
git push --quiet -u origin "$BRANCH"
gh pr create --repo "$SLUG" --base main --head "$BRANCH" \
	--title "Odin $NEW" --body "Version bump for the $TAG release." >/dev/null
# main requires CI's `check` job, so a merge before it passes is refused. The
# check takes a moment to register on a new PR; then watch it to the end.
echo "==> waiting for CI on the version bump (about 10 minutes)"
for _ in $(seq 30); do
	out=$(gh pr checks "$BRANCH" --repo "$SLUG" 2>&1 || true)
	[[ $out == *"no checks reported"* ]] || break
	sleep 2
done
gh pr checks "$BRANCH" --repo "$SLUG" --watch --fail-fast
gh pr merge "$BRANCH" --repo "$SLUG" --squash --delete-branch

cd "$REPO"
echo "==> building $TAG (about 10 minutes)"
gh workflow run Release --repo "$SLUG"
# ponytail: the dispatched run takes a moment to exist, so wait for one that
# started after we asked rather than watching whatever ran last. Give up after a
# minute — if it never appears, the dispatch is the thing that went wrong.
for _ in $(seq 30); do
	RUN=$(gh run list --repo "$SLUG" --workflow Release --limit 1 \
		--json databaseId,status -q '.[] | select(.status != "completed") | .databaseId')
	[[ -n "$RUN" ]] && break
	sleep 2
done
[[ -n "${RUN:-}" ]] || { echo "no Release run started" >&2; exit 1; }
gh run watch "$RUN" --repo "$SLUG" --exit-status

if [[ "$INSTALL" == 0 ]]; then
	echo "==> $TAG published; this machine stays on $(defaults read /Applications/Odin.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null || echo unknown)"
	exit 0
fi

echo "==> installing"
brew upgrade --cask --greedy odin
# Releases are signed with a self-signed certificate, so macOS quarantines the
# download and offers no way past the dialog. Clearing it is not optional.
xattr -dr com.apple.quarantine /Applications/Odin.app

HAVE=$(defaults read /Applications/Odin.app/Contents/Info.plist CFBundleShortVersionString)
[[ "$HAVE" == "$NEW" ]] || { echo "installed $HAVE, expected $NEW" >&2; exit 1; }
echo "==> Odin $NEW is in /Applications"
