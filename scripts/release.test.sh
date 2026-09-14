#!/usr/bin/env bash
# Self-check for release.sh's two silent-failure modes.
#
# Both fail by doing nothing rather than by erroring: a sed whose anchor no
# longer matches leaves the version untouched, and a version the release already
# has makes CI clobber that release's asset instead of cutting a new one. Neither
# shows up until a build is already on its way out, so the shape release.sh
# assumes gets checked here instead.
#
#   scripts/release.test.sh
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DIR/.." && pwd)"

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

MANIFESTS=(apps/desktop/package.json packages/host-service/package.json)

# The sed anchors on a single tab-indented "version" line. Two of them (or none,
# after a reformat to spaces) and the bump silently misses.
for m in "${MANIFESTS[@]}"; do
	n=$(grep -c $'^\t"version": ' "$REPO/$m")
	[[ "$n" == 1 ]] || fail "$m has $n tab-indented \"version\" lines, want exactly 1"
done

# release.sh reads the version from desktop and writes it to both. If they have
# drifted apart, the write closes the gap without anyone deciding to.
desktop=$(jq -r .version "$REPO/${MANIFESTS[0]}")
host=$(jq -r .version "$REPO/${MANIFESTS[1]}")
[[ "$desktop" == "$host" ]] ||
	fail "desktop is $desktop but host-service is $host — they share a version"

# bun.lock carries both, and CI installs with --frozen-lockfile.
[[ $(grep -c "\"version\": \"$desktop\"" "$REPO/bun.lock") -ge 2 ]] ||
	fail "bun.lock does not record $desktop for both packages — refresh it"

# The patch bump, the one piece of arithmetic in the script.
got=$(awk -F. '{print $1"."$2"."$3+1}' <<<"1.18.9")
[[ "$got" == "1.18.10" ]] || fail "patch bump of 1.18.9 gave $got, want 1.18.10"

echo "PASS: version lives in one anchored line per manifest, in sync, at $desktop"
