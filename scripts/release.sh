#!/usr/bin/env bash
# Cut a release: bump the version, build the DMG on CI, and install it over
# /Applications/Odin.app.
#
#   scripts/release.sh               # patch bump (1.18.4 -> 1.18.5)
#   scripts/release.sh 1.19.0        # explicit version
#   scripts/release.sh --no-install  # publish it, stay on the build you have
#   scripts/release.sh --private     # a draft only collaborators see: the DMG
#                                    # lands in ~/Downloads to send by hand
#   scripts/release.sh --private 1.1.0  # the same draft, as 1.1.0-pre.<run>
#   scripts/release.sh --silent      # publish it without moving "latest":
#                                    # no update banner, no brew upgrade - only
#                                    # the people you send its link get it
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
# repo - clear the list (KEY_0) before naming this one (KEY_1).
#
# KEY_2 is what makes the other two matter: `origin` is an SSH remote, and git
# never consults a credential helper for SSH. Reads succeed on the key alone,
# so this only shows up at the push - "Please make sure you have the correct
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

# --no-install publishes the release without upgrading this machine onto it -
# which is how you get a version to test the app's own updater against.
INSTALL=1
# --silent publishes it without making it the latest release: the app's update
# banner and the brew cask both read /releases/latest, so neither offers it.
# Its own download link still works. A later normal release becomes latest as
# usual; `gh release edit <tag> --latest` promotes this one instead.
SILENT=0
# --private builds main as a draft release, which only the repo's
# collaborators can see: no banner, no brew, nothing public. Its version is
# the next patch with -pre.<run> (1.0.22-pre.57), so the real 1.0.22 still
# updates whoever runs it. No version bump on main: the build bumps in place.
PRIVATE=0
while [[ "${1:-}" == --* ]]; do
	case "$1" in
	--no-install) INSTALL=0 ;;
	--silent) SILENT=1 INSTALL=0 ;;
	--private) PRIVATE=1 INSTALL=0 ;;
	*) echo "unknown flag: $1" >&2; exit 1 ;;
	esac
	shift
done

# The Release run this just dispatched, watched to the end.
watch_release() {
	local run=""
	for _ in $(seq 30); do
		run=$(gh run list --repo "$SLUG" --workflow Release --limit 1 \
			--json databaseId,status -q '.[] | select(.status != "completed") | .databaseId')
		[[ -n "$run" ]] && break
		sleep 2
	done
	[[ -n "$run" ]] || { echo "no Release run started" >&2; exit 1; }
	gh run watch "$run" --repo "$SLUG" --exit-status
}

if [[ "$PRIVATE" == 1 ]]; then
	echo "==> building a private draft of main (about 10 minutes)"
	gh workflow run Release --repo "$SLUG" -f private=true -f version="${1:-}"
	watch_release
	TAG=$(gh release list --repo "$SLUG" --limit 10 --json tagName,isDraft \
		-q '[.[] | select(.isDraft)][0].tagName')
	OUT="$HOME/Downloads/Odin-$TAG.dmg"
	gh release download "$TAG" --repo "$SLUG" --pattern Odin-arm64.dmg --output "$OUT" --clobber
	echo "==> $TAG is a draft (not public). Send this file: $OUT"
	echo "    Installing it: drag Odin to Applications, then"
	echo "    xattr -dr com.apple.quarantine /Applications/Odin.app"
	exit 0
fi

# Bump from the newest release, not main's package.json: a manual Release run
# publishes the next patch without committing it, so main can lag behind. The
# newest, not the one marked latest: a silent release is newer than that.
OLD=$(gh release list --repo "$SLUG" --exclude-drafts --limit 1 --json tagName -q '.[0].tagName')
OLD=${OLD#v}
NEW="${1:-$(awk -F. '{print $1"."$2"."$3+1}' <<<"$OLD")}"
TAG="v$NEW"

# release.yml would fail on a taken version too, but only after a 10-minute
# build and a merged version bump - catch it here first.
if gh release view "$TAG" --repo "$SLUG" >/dev/null 2>&1; then
	echo "$TAG is already released - pass a version that is not taken" >&2
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
# records both - CI installs with --frozen-lockfile, so a stale lock fails the
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
gh workflow run Release --repo "$SLUG" -f silent="$([[ "$SILENT" == 1 ]] && echo true || echo false)"
watch_release

if [[ "$SILENT" == 1 ]]; then
	echo "==> $TAG published silently (not latest). Its download:"
	echo "    https://github.com/$SLUG/releases/download/$TAG/Odin-arm64.dmg"
	exit 0
fi

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
