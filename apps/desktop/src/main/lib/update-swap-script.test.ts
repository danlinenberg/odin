import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote, swapScript } from "./update-swap-script";

const script = swapScript({
	appBundle: "/Applications/Odin.app",
	mountPoint: "/tmp/odin-update-x/mnt",
	workDir: "/tmp/odin-update-x",
});

describe("swapScript", () => {
	test("is valid bash", () => {
		const parsed = spawnSync("/bin/bash", ["-n"], { input: script });
		expect(parsed.stderr.toString()).toBe("");
		expect(parsed.status).toBe(0);
	});

	test("survives a path that would break naive quoting", () => {
		const nasty = swapScript({
			appBundle: "/Volumes/My Disk/It's Odin.app",
			mountPoint: "/tmp/m",
			workDir: "/tmp/w",
		});
		expect(spawnSync("/bin/bash", ["-n"], { input: nasty }).status).toBe(0);
		expect(nasty).toContain(`APP='/Volumes/My Disk/It'\\''s Odin.app'`);
	});

	test("shellQuote closes the quote it opens", () => {
		expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
	});
});

/**
 * The wait loop gates an `mv` of the installed bundle, so it has to see the UI
 * and not see the daemon — which runs the same binary from the same bundle.
 * `ps` is stubbed with a shell function so the real process table stays out of
 * it; the stub also carries a grep whose own argv holds the bundle path, the
 * self-match that `grep -vw grep` fails to filter under ugrep.
 */
function uiRunning(processTable: string): boolean {
	const dir = mkdtempSync(join(tmpdir(), "swap-script-test-"));
	const path = join(dir, "check.sh");
	const body = script.slice(
		script.indexOf("ui_running() {"),
		script.indexOf("for _ in $(seq 60); do"),
	);
	writeFileSync(
		path,
		`APP=/Applications/Odin.app\nps() { printf '%s' ${shellQuote(processTable)}; }\n${body}\nui_running\n`,
	);
	return spawnSync("/bin/bash", [path]).status === 0;
}

describe("the wait loop's UI check", () => {
	const UI = "  501 /Applications/Odin.app/Contents/MacOS/Odin\n";
	const DAEMON =
		"  502 /Applications/Odin.app/Contents/MacOS/Odin /Applications/Odin.app/Contents/Resources/app.asar/dist/main/terminal-host.js\n";
	const SELF_MATCHING_GREP =
		"  503 ugrep -F /Applications/Odin.app/Contents/MacOS/Odin\n";

	test("sees the UI", () => {
		expect(uiRunning(UI + DAEMON)).toBe(true);
	});

	test("does not see the daemon on its own", () => {
		expect(uiRunning(DAEMON)).toBe(false);
	});

	test("is not fooled by a grep carrying the path in its argv", () => {
		expect(uiRunning(DAEMON + SELF_MATCHING_GREP)).toBe(false);
	});
});
