#!/usr/bin/env bash
# CI's Android check (.github/workflows/ci.yml, job `android`), inside a
# running emulator: installs the debug APK, pairs it with `bun run fake-odin`
# through the odin://pair link (as the QR code does), and waits for the board's
# sample sessions to show. Leaves a screenshot in $OUT.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-${RUNNER_TEMP:-/tmp}/android}"
mkdir -p "$OUT"

bun scripts/fake-odin.ts >"$OUT/fake-odin.log" 2>&1 &
trap 'kill %1 2>/dev/null || true' EXIT
for _ in $(seq 30); do
	grep -q "odin://pair" "$OUT/fake-odin.log" && break
	sleep 1
done
link=$(grep -o 'odin://pair?[^"]*' "$OUT/fake-odin.log")
# The link says ws://localhost:4799: the emulator's localhost, sent to fake-odin here.
adb reverse tcp:4799 tcp:4799

adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell "am start -W -a android.intent.action.VIEW -d '$link' com.danlinenberg.odin"

status=0
bun scripts/android-check.ts || status=$?
adb exec-out screencap -p >"$OUT/board.png" || true
adb logcat -d >"$OUT/logcat.txt" || true
exit "$status"
