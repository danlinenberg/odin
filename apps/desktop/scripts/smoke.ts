/**
 * Smoke test for Odin's main flows, against the BUILT app in a throwaway home.
 *
 *   bun run compile:app && bun run smoke        # from apps/desktop
 *
 * Boots dist/ with HOME, ODIN_HOME_DIR, TMPDIR and the Chromium profile all in
 * a fresh /tmp dir — the pty-daemon socket and manifest hang off those, so it
 * can't adopt a running Odin's daemon or take its single-instance lock — then
 * drives the renderer over CDP the way a person would: click the rail, write
 * a task down, add a profile, press ⌘F. Exits 1 with a list of what broke;
 * SMOKE_SHOTS_DIR=<dir> also saves a screenshot of every failed step.
 *
 * Dependency-free (Bun WebSocket + fetch), like the other cdp-*.ts scripts.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import electronBinary from "electron";

const PORT = 19_331;
const APP_DIR = join(import.meta.dir, "..");
const SHOTS = process.env.SMOKE_SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// Short root: Darwin caps a unix socket path at 104 bytes.
const home = mkdtempSync("/tmp/odin-smoke-");
const env: Record<string, string | undefined> = {
	...process.env,
	HOME: home,
	ODIN_HOME_DIR: join(home, ".odin"),
	TMPDIR: home,
	NODE_ENV: "production",
};
// Set inside an Odin terminal; it would boot Electron as plain node.
delete env.ELECTRON_RUN_AS_NODE;

const app = spawn(
	electronBinary as unknown as string,
	[
		APP_DIR,
		`--remote-debugging-port=${PORT}`,
		`--user-data-dir=${join(home, "chromium")}`,
	],
	{ env, stdio: ["ignore", "pipe", "pipe"] },
);
let appLog = "";
app.stdout?.on("data", (c) => {
	appLog += c;
});
app.stderr?.on("data", (c) => {
	appLog += c;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function quit(code: number): Promise<never> {
	app.kill("SIGTERM");
	await Promise.race([new Promise((r) => app.once("exit", r)), sleep(5000)]);
	// The terminal-host daemon, pty-daemon and host-service outlive the app by
	// design. Whatever still holds a file under the throwaway home (or names
	// it in its argv) is one of them — nothing else on the machine does.
	const holders = Bun.spawnSync(["lsof", "-t", "+D", home]).stdout.toString();
	for (const pid of new Set(holders.split("\n").filter(Boolean))) {
		try {
			process.kill(Number(pid), "SIGKILL");
		} catch {}
	}
	Bun.spawnSync(["pkill", "-9", "-f", home]);
	rmSync(home, { recursive: true, force: true });
	process.exit(code);
}
setTimeout(() => {
	console.error("FAIL smoke timed out\n", appLog.slice(-4000));
	void quit(1);
}, 240_000).unref();

// --- CDP ---------------------------------------------------------------------
type Target = { type: string; url: string; webSocketDebuggerUrl?: string };
let target: Target | undefined;
for (let i = 0; i < 60 && !target; i++) {
	await sleep(1000);
	const targets = (await fetch(`http://127.0.0.1:${PORT}/json/list`)
		.then((r) => r.json())
		.catch(() => [])) as Target[];
	target = targets.find(
		(t) => t.type === "page" && t.url.includes("index.html"),
	);
}
if (!target?.webSocketDebuggerUrl) {
	console.error("FAIL no renderer page came up\n", appLog.slice(-4000));
	await quit(1);
}

const exceptions: string[] = [];
const ws = new WebSocket(target?.webSocketDebuggerUrl as string);
let nextId = 1;
const pending = new Map<number, (m: CdpReply) => void>();
type CdpReply = { error?: { message: string }; result?: CdpResult };
type CdpResult = {
	result?: { value?: unknown };
	exceptionDetails?: { text: string };
	data?: string;
};
ws.onmessage = (e) => {
	const m = JSON.parse(String(e.data));
	if (m.method === "Runtime.exceptionThrown") {
		const d = m.params.exceptionDetails;
		exceptions.push(d.exception?.description ?? d.text);
	}
	pending.get(m.id)?.(m);
	pending.delete(m.id);
};
await new Promise((r) => {
	ws.onopen = r;
});
function send(method: string, params: object = {}): Promise<CdpResult> {
	const id = nextId++;
	ws.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve, reject) =>
		pending.set(id, (m) =>
			m.error ? reject(new Error(m.error.message)) : resolve(m.result ?? {}),
		),
	);
}
await send("Runtime.enable");

// Helpers for page expressions, re-declared on every call so a renderer
// reload can't drop them. A control's label is its aria-label, else its
// title, else its text — the rail is icon buttons, Settings is links.
const IN_PAGE = `
	var __label = (e) => (e.getAttribute("aria-label") || e.getAttribute("title") || e.textContent || "").trim();
	var __find = (selector, label, within = document) =>
		[...within.querySelectorAll(selector)].find((e) => __label(e).startsWith(label));
	var __text = () => document.body.innerText.toLowerCase();
`;

/** Evaluate in the page; the value comes back by value. */
async function page<T>(expression: string): Promise<T> {
	const { result, exceptionDetails } = await send("Runtime.evaluate", {
		expression: `${IN_PAGE}\n${expression}`,
		returnByValue: true,
		awaitPromise: true,
	});
	if (exceptionDetails) throw new Error(exceptionDetails.text);
	return result?.value as T;
}

/** Click the first `selector` whose label starts with `label`. */
async function click(selector: string, label: string) {
	const found = await page<boolean>(
		`(() => { const e = __find(${JSON.stringify(selector)}, ${JSON.stringify(label)}); e?.click(); return !!e; })()`,
	);
	if (!found) throw new Error(`no ${selector} labelled "${label}"`);
	await sleep(400);
}
/** Type into a React-controlled field the way a keystroke would. */
async function fill(selector: string, value: string) {
	const found = await page<boolean>(`(() => {
		const el = document.querySelector(${JSON.stringify(selector)});
		if (!el) return false;
		el.focus();
		Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set.call(el, ${JSON.stringify(value)});
		el.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	})()`);
	if (!found) throw new Error(`no field ${selector}`);
}
async function waitForText(needle: string, present = true, ms = 15_000) {
	const expr = `__text().includes(${JSON.stringify(needle.toLowerCase())})`;
	for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
		if ((await page<boolean>(expr)) === present) return;
	}
	throw new Error(
		`"${needle}" ${present ? "never appeared" : "never went away"}`,
	);
}
async function expectHealthy() {
	const body = await page<string>("document.body.innerText");
	for (const crash of ["Something went wrong", "Odin failed to start"]) {
		if (body.includes(crash))
			throw new Error(`"${crash}": ${body.slice(0, 400)}`);
	}
}
const rail = (label: string) => click("button", label);

// --- flows -------------------------------------------------------------------
const failures: string[] = [];
async function step(name: string, flow: () => Promise<void>) {
	try {
		await flow();
		await expectHealthy();
		console.log(`ok   ${name}`);
	} catch (error) {
		failures.push(`${name}: ${(error as Error).message}`);
		console.log(`FAIL ${name}\n     ${(error as Error).message}`);
		if (SHOTS) {
			const { data } = await send("Page.captureScreenshot");
			await Bun.write(
				join(SHOTS, `${name.replace(/\W+/g, "-")}.png`),
				Buffer.from(data as string, "base64"),
			);
		}
	}
}

await step("boots straight onto the Dev Board, no sign-in", async () => {
	await waitForText("next in line", true, 60_000);
	for (const column of ["working", "needs you", "done", "idle"])
		await waitForText(column);
	const hash = await page<string>("location.hash");
	if (!hash.startsWith("#/board")) throw new Error(`landed on ${hash}`);
});

// Each rail entry and a line only its screen prints.
const SCREENS: [string, string][] = [
	["Tasks", "waiting on you"],
	["Review", "sweep now"],
	["Automations", "add automation"],
	["Insights", "who asks"],
	["Session History", "every session odin launched"],
	["Dev Board", "next in line"],
];
for (const [label, line] of SCREENS) {
	await step(`rail: ${label} opens`, async () => {
		await rail(label);
		await waitForText(line);
	});
}

await step("Tasks: every feed tab opens", async () => {
	await rail("Tasks");
	await waitForText("waiting on you");
	// The strip is the parent of its Slack tab; "Tasks" is also a rail label.
	for (const tab of [
		"All",
		"Tasks",
		"Slack",
		"Jira",
		"GitHub",
		"Notion",
		"Email",
	]) {
		const found = await page<boolean>(`(() => {
			const strip = __find("button", "Slack").parentElement;
			const e = __find("button", ${JSON.stringify(tab)}, strip);
			e?.click();
			return !!e;
		})()`);
		if (!found) throw new Error(`no "${tab}" tab`);
		await sleep(400);
		await expectHealthy();
	}
});

for (const [label, line] of [
	["Tasks", "waiting on you"],
	["Dev Board", "next in line"],
	["Session History", "every session odin launched"],
]) {
	await step(`⌘F focuses the search box on ${label}`, async () => {
		await rail(label);
		await waitForText(line);
		await page(`document.activeElement?.blur()`);
		await page(
			`document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", metaKey: true, bubbles: true }))`,
		);
		await sleep(300);
		const focused = await page<string>(
			`document.activeElement?.tagName + " " + (document.activeElement?.getAttribute("placeholder") ?? "")`,
		);
		if (!/^INPUT .*(search|⌘F)/i.test(focused))
			throw new Error(`focus went to ${focused}`);
	});
}

const TASK = `Smoke task ${Date.now()}`;
await step("a task written down lands in Tasks", async () => {
	await rail("Dev Board");
	await click("button", "Add task");
	await fill('input[placeholder="What needs doing?"]', TASK);
	// The dialog's submit is the last "Add task" — the checklist has one too.
	await page(
		`[...document.querySelectorAll("button")].filter((e) => __label(e) === "Add task").at(-1).click()`,
	);
	await rail("Tasks");
	await waitForText(TASK);
});

await step("a new profile sees none of the first one's tasks", async () => {
	await rail("Settings");
	await waitForText("profiles");
	await fill('input[placeholder="New profile name"]', "Smoke");
	await click("button", "Add profile");
	await click("button", "Switch to");
	await click("a", "Back");
	await rail("Tasks");
	await waitForText("waiting on you");
	await waitForText(TASK, false);
	// And back: the first profile's task is still there.
	await rail("Settings");
	await click("button", "Switch to");
	await click("a", "Back");
	await rail("Tasks");
	await waitForText(TASK);
});

await step("Done takes a task off the list", async () => {
	await rail("Tasks");
	await waitForText(TASK);
	// The title button is labelled "Open the Tasks feed"; match its text.
	const found = await page<boolean>(`(() => {
		let row = [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === ${JSON.stringify(TASK)});
		while (row && !row.querySelector('button[title="Mark done"]')) row = row.parentElement;
		row?.querySelector('button[title="Mark done"]').click();
		return !!row;
	})()`);
	if (!found) throw new Error("no Done button on the task's row");
	await waitForText(TASK, false);
});

// Settings is five fixed screens; each sidebar link and the route it opens.
const SETTINGS: [string, string][] = [
	["Connections", "#/settings/connections"],
	["Sessions", "#/settings/sessions"],
	["Backlog", "#/settings/backlog"],
	["Notifications", "#/settings/ringtones"],
	["Keyboard", "#/settings/keyboard"],
];
await step("Settings is exactly its five screens, and each opens", async () => {
	await rail("Settings");
	await waitForText("profiles");
	const links = await page<string[]>(
		`[...document.querySelectorAll("a")].map((a) => a.innerText.split("\\n")[0].trim()).filter((t) => t && t !== "Back")`,
	);
	const expected = SETTINGS.map(([label]) => label);
	if (links.join() !== expected.join())
		throw new Error(`sidebar is [${links}], expected [${expected}]`);
	for (const [label, route] of SETTINGS) {
		await click("a", label);
		const hash = await page<string>("location.hash");
		if (!hash.startsWith(route)) throw new Error(`${label} opened ${hash}`);
		await expectHealthy();
	}
	await click("a", "Back");
	await waitForText("waiting on you");
});

await step("no uncaught errors in the renderer", async () => {
	if (exceptions.length) throw new Error(exceptions.join("\n     "));
});

console.log(
	failures.length ? `\n${failures.length} flow(s) broken` : "\nall flows pass",
);
await quit(failures.length ? 1 : 0);
