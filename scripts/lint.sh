#!/bin/bash
# Wrapper for biome check that fails on ANY diagnostic (info, warn, or error)

output=$(bunx @biomejs/biome@2.4.2 check "$@" 2>&1)
exit_code=$?

echo "$output"

# Check if there are any diagnostics (errors, warnings, or infos)
if echo "$output" | grep -qE "Found [0-9]+ (error|info|warning)"; then
  exit 1
fi

# Run every guard even after one fails, so a contributor sees all violations
# in a single pass. Don't use `set -e` here: it would abort before the biome
# output above is echoed.
./scripts/check-git-ref-strings.sh || exit_code=1
./scripts/check-simple-git-usage.sh || exit_code=1
# Plain hyphens only. The em dash is spelled as bytes so this file has none.
if git grep -nI $'\xe2\x80\x94'; then
	echo "[em-dash] use a plain hyphen (-) instead of an em dash" >&2
	exit_code=1
fi

exit $exit_code
