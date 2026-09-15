#!/usr/bin/env bun
/**
 * End-to-end QA for the PACKAGED Odin.app — the full user journey:
 *
 *   fresh universe → boot (no login) → type a task on the board →
 *   workspace auto-provisions → session launches → drawer terminal shows
 *   the task prompt actually delivered, in the right cwd, in auto mode.
 *
 * Run: bun tools/e2e-packaged.mjs [--keep-data]
 * Exits 0 only when every assertion holds. Prints JSON + saves screenshots
 * next to the script (or $E2E_SHOTS_DIR).
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APP =
	process.env.ODIN_APP ??
	join(import.meta.dir, "../apps/desktop/release/mac-arm64/Odin.app");
const BIN = join(APP, "Contents/MacOS/Odin");
const PORT = 19224;
const SHOTS = process.env.E2E_SHOTS_DIR ?? import.meta.dir;
const TASK_TEXT = `E2E ${Date.now()}: create a file ODIN_E2E.txt containing "ok" in the repo root`;

const report = { checks: [], screenshots: [] };
const check = (name, ok, detail = "") => {
	report.checks.push({ name, ok, detail });
	console.error(
		`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`,
	);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. reset universe (park, don't delete) --------------------------------
try {
	execSync(`osascript -e 'quit app "Odin"' 2>/dev/null; pkill -f "${BIN}"`, {
		shell: "/bin/zsh",
	});
} catch {}
await wait(2500);
if (!process.argv.includes("--keep-data")) {
	const stamp = Date.now();
	for (const dir of [
		join(homedir(), ".odin"),
		join(homedir(), "Library/Application Support/Odin"),
	]) {
		if (existsSync(dir)) renameSync(dir, `${dir}.e2e-bak-${stamp}`);
	}
	check("universe-reset", true);
}

// --- 2. launch with clean env + CDP ----------------------------------------
const env = { ...process.env };
delete env.ODIN_HOME_DIR; // Dan's shell exports it globally
const child = spawn(BIN, [`--remote-debugging-port=${PORT}`], {
	env,
	detached: true,
	stdio: "ignore",
});
child.unref();

let target = null;
for (let i = 0; i < 30; i++) {
	await wait(2000);
	try {
		const targets = await (
			await fetch(`http://127.0.0.1:${PORT}/json/list`)
		).json();
		target = targets.find(
			(t) => t.type === "page" && !/devtools/.test(t.url ?? ""),
		);
		if (target) break;
	} catch {}
}
check("app-booted-cdp", !!target);
if (!target) finish();

// --- CDP plumbing -----------------------------------------------------------
const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();
ws.onmessage = (e) => {
	const m = JSON.parse(e.data);
	if (m.id && pending.has(m.id)) {
		const p = pending.get(m.id);
		pending.delete(m.id);
		m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
	}
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) =>
	new Promise((resolve, reject) => {
		const id = msgId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
await send("Page.enable");
await send("Runtime.enable");
const ev = async (expr) =>
	(
		await send("Runtime.evaluate", {
			expression: expr,
			returnByValue: true,
			awaitPromise: true,
		})
	).result.value;
const shot = async (name) => {
	const { data } = await send("Page.captureScreenshot", { format: "png" });
	const path = `${SHOTS}/${name}.png`;
	await Bun.write(path, Buffer.from(data, "base64"));
	report.screenshots.push(path);
};

// --- 3. board reachable without login ---------------------------------------
let onBoard = false;
for (let i = 0; i < 30; i++) {
	if (await ev(`document.body?.innerText.includes("Dev Board") ?? false`)) {
		onBoard = true;
		break;
	}
	if (await ev(`document.body?.innerText.includes("Sign in") ?? false`)) break;
	await ev(
		`[...document.querySelectorAll("button")].find(el => ["Dev board","Dev Board"].includes(el.getAttribute("aria-label")))?.click()`,
	);
	await wait(1500);
}
check("board-no-login", onBoard);
check(
	"isolated-universe",
	existsSync(join(homedir(), ".odin")),
	"~/.odin exists",
);
if (!onBoard) {
	await shot("e2e-fail-boot");
	finish();
}

// --- 4. type a task ----------------------------------------------------------
// Clear the proof artifact BEFORE the agent starts (see step 6)
try {
	execSync(`rm -f "$HOME/dev/imagen/internal-claude/ODIN_E2E.txt"`);
} catch {}
await ev(`(() => {
	const input = document.querySelector('input[placeholder^="New task"]');
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
	setter.call(input, ${JSON.stringify(TASK_TEXT)});
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	return true;
})()`);

// --- 5. exactly one card appears, session working ---------------------------
let cardCount = 0;
for (let i = 0; i < 40; i++) {
	await wait(3000);
	cardCount = await ev(
		`document.querySelectorAll('[role="button"][tabindex]').length`,
	);
	if (cardCount > 0) break;
}
check("one-card-no-preset-noise", cardCount === 1, `${cardCount} card(s)`);
const cardTitle = await ev(
	`document.querySelector('[role="button"][tabindex]')?.innerText.split("\\n")[0] ?? ""`,
);
check(
	"card-titled-after-task",
	cardTitle.includes("E2E"),
	JSON.stringify(cardTitle.slice(0, 60)),
);

// --- 6. THE assertion: the agent actually did the task ----------------------
// The task instructs the agent to create ODIN_E2E.txt in the repo root, so
// the file appearing proves prompt delivery + correct cwd + auto mode in one
// observable outcome. (xterm paints to canvas — reading its DOM text lies.)
await ev(`document.querySelector('[role="button"][tabindex]')?.click()`);
const proofPath = join(homedir(), "dev/imagen/internal-claude/ODIN_E2E.txt");
let proof = false;
for (let i = 0; i < 60; i++) {
	await wait(4000);
	if (existsSync(proofPath)) {
		proof = true;
		break;
	}
}
check("agent-executed-task", proof, proofPath);
await shot("e2e-packaged-final");

finish();

function finish() {
	const failed = report.checks.filter((c) => !c.ok);
	report.verdict = failed.length === 0 ? "PASS" : "FAIL";
	console.log(JSON.stringify(report, null, 2));
	process.exit(failed.length === 0 ? 0 : 1);
}
