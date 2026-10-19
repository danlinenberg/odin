#!/usr/bin/env bash
# The App Store screenshots (6.9-inch iPhone, 1320x2868), from fake-odin's
# sample sessions: bun run screenshots
#
# Makes a throwaway "Odin Store" simulator (a fresh one has no leftover
# system prompts), sets a clean status bar, runs the app in live mode against
# fake-odin, drives each screen through the dev server's eval bridge, and
# saves store/screenshots/iphone-6.9/*.png. Stops what it started and deletes
# the simulator at the end. Other booted simulators are shut down, so the
# eval bridge talks to one page only.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=store/screenshots/iphone-6.9
TMP=$(mktemp -d)
mkdir -p "$OUT"

DEVICE="Odin Store"
xcrun simctl delete "$DEVICE" 2>/dev/null || true
xcrun simctl shutdown all
UDID=$(xcrun simctl create "$DEVICE" "iPhone 18 Pro Max")
xcrun simctl boot "$UDID"
xcrun simctl status_bar "$UDID" override --time 9:41 --dataNetwork wifi \
  --wifiMode active --wifiBars 3 --cellularMode active --cellularBars 4 \
  --batteryState charged --batteryLevel 100

bun scripts/fake-odin.ts > "$TMP/fake.log" 2>&1 &
FAKE=$!
bunx vite --port 5175 --strictPort > "$TMP/vite.log" 2>&1 &
VITE=$!
cleanup() {
  kill "$FAKE" "$VITE" 2>/dev/null || true
  xcrun simctl status_bar "$UDID" clear 2>/dev/null || true
  xcrun simctl delete "$UDID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT
sleep 4

ODIN_LIVE_URL=http://localhost:5175/ ODIN_SIM_DEVICE="$DEVICE" bash scripts/sim.sh --live

# Runs JS in the app's page and prints the answer.
run() { curl -s --data-binary @"$1" localhost:5175/__eval; echo; }
shot() { sleep "${2:-3}"; xcrun simctl io "$UDID" screenshot "$OUT/$1.png" >/dev/null; }

# The page's live socket takes a moment on a fresh simulator.
echo 'location.href' > "$TMP/ping.js"
for _ in $(seq 1 30); do
  run "$TMP/ping.js" | grep -q localhost && break
  sleep 2
done

shot 05-pair 1

LINK=$(grep -o 'odin://pair[^"]*' "$TMP/fake.log")
printf 'localStorage.setItem("odin-phone-pairing", "%s"); setTimeout(() => location.reload(), 100); "ok"' "$LINK" > "$TMP/pair.js"
run "$TMP/pair.js"
shot 01-board 9

echo 'location.hash = "#/s/p1"; "ok"' > "$TMP/session.js"
run "$TMP/session.js"
shot 02-session 5

cat > "$TMP/brief.js" <<'JS'
(async () => {
	const toggle = [...document.querySelectorAll("button")].find((b) =>
		/^(TL;DR|BRIEF)/.test(b.textContent.trim()),
	);
	toggle.click();
	await new Promise((r) => setTimeout(r, 2500));
	for (const el of document.querySelectorAll("*"))
		if (el.scrollHeight > el.clientHeight + 10) el.scrollTop = 0;
	return "opened";
})()
JS
run "$TMP/brief.js"
shot 03-brief 2

cat > "$TMP/task.js" <<'JS'
(async () => {
	location.hash = "";
	await new Promise((r) => setTimeout(r, 1500));
	document.querySelector('button[aria-label="New task"]').click();
	await new Promise((r) => setTimeout(r, 1000));
	const text = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
	const box = document.querySelector("textarea");
	text.set.call(box, "Add a dark mode toggle to the export dialog, and keep the last choice per user");
	box.dispatchEvent(new Event("input", { bubbles: true }));
	box.blur();
	const pick = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
	const repo = [...document.querySelectorAll("select")].find(
		(s) => s.getAttribute("aria-label") !== "Profile",
	);
	pick.set.call(repo, [...repo.options].find((o) => o.value).value);
	repo.dispatchEvent(new Event("change", { bubbles: true }));
	return "typed";
})()
JS
run "$TMP/task.js"
shot 04-new-task 2

for f in "$OUT"/*.png; do
  echo "$f $(sips -g pixelWidth -g pixelHeight "$f" | awk '/pixel/{printf $2" "}')"
done
