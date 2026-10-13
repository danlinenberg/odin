/**
 * Smoke test for Odin's main flows, against the BUILT app in a throwaway home.
 *
 *   bun run compile:app && bun run smoke        # from apps/desktop
 *
 * Boots dist/ with HOME, ODIN_HOME_DIR, TMPDIR and the Chromium profile all in
 * a fresh /tmp dir - the pty-daemon socket and manifest hang off those, so it
 * can't adopt a running Odin's daemon or take its single-instance lock - then
 * drives the renderer over CDP the way a person would: click the rail, write
 * a task down, add a profile, press ⌘F, start a session (on a fake `claude`)
 * and mark it done. Exits 1 with a list of what broke;
 * SMOKE_SHOTS_DIR=<dir> also saves a screenshot of every failed step.
 *
 * Dependency-free (Bun WebSocket + fetch), like the other cdp-*.ts scripts.
 */
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import electronBinary from "electron";

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
	// No Dock icon, and the window never takes focus from the user.
	ODIN_SMOKE: "1",
};
// Set inside an Odin terminal; it would boot Electron as plain node.
delete env.ELECTRON_RUN_AS_NODE;

// A crow conversation an earlier run left open: it has to survive the
// restart and take the next ask.
const QUESTION = "Smoke question";
mkdirSync(join(home, ".odin"));
writeFileSync(
	join(home, ".odin", "app-state.json"),
	JSON.stringify({
		tabsState: {
			tabs: [
				{
					id: "tab-smoke-question",
					name: QUESTION,
					workspaceId: "smoke-workspace",
					createdAt: 0,
					layout: "pane-smoke-question",
				},
			],
			panes: {
				"pane-smoke-question": {
					id: "pane-smoke-question",
					tabId: "tab-smoke-question",
					type: "terminal",
					name: QUESTION,
					claudeSessionId: crypto.randomUUID(),
					odinTags: ["question"],
				},
			},
		},
	}),
);

// A checkout for sessions to start in, and a stand-in for Claude Code: it
// records how Odin invoked it and the pane it runs in, then stays alive the
// way a working session does.
const repo = join(home, "dev", "smoke-repo");
mkdirSync(repo, { recursive: true });
writeFileSync(
	join(home, ".gitconfig"),
	"[user]\n\tname = Odin Smoke\n\temail = smoke@odin.local\n",
);
for (const args of [
	["init", "-q", "-b", "main"],
	["commit", "-q", "--allow-empty", "-m", "init"],
])
	Bun.spawnSync(["git", "-C", repo, ...args], { env: { ...env } });
env.DAN_DEFAULT_REPO = repo;
// Either would point the app at the real config or shell setup.
delete env.ODIN_CONFIG_PATH;
delete env.ZDOTDIR;
mkdirSync(join(home, "bin"));
writeFileSync(
	join(home, "bin", "claude"),
	// One file per run, named by pid (exec keeps it), moved into place whole.
	// A --session-id launch leaves a transcript, like the real one: Resume
	// refuses an id Claude never saved.
	`#!/bin/sh\nfor a; do [ "$prev" = --session-id ] && mkdir -p "$HOME/.claude/projects/smoke" && : > "$HOME/.claude/projects/smoke/$a.jsonl"; prev=$a; done\nprintf '%s %s' "$ODIN_PORT" "$ODIN_PANE_ID" > "$HOME/pane-$$"\nprintf '%s\\n' "$@" > "$HOME/.claude-$$"\nmv "$HOME/.claude-$$" "$HOME/claude-$$.args"\necho "fake claude is working"\nexec sleep 600\n`,
	{ mode: 0o755 },
);
// Sessions run in a login shell, which reads these after macOS's path_helper
// has reordered PATH - so the fake beats a real claude in /opt/homebrew/bin.
for (const profile of [".zprofile", ".bash_profile"])
	writeFileSync(join(home, profile), 'export PATH="$HOME/bin:$PATH"\n');

const app = spawn(
	electronBinary as unknown as string,
	[
		APP_DIR,
		// 0 = any free port: agents run smoke in parallel worktrees.
		"--remote-debugging-port=0",
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
	// it in its argv) is one of them - nothing else on the machine does.
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
}, 300_000).unref();

// --- CDP ---------------------------------------------------------------------
type Target = { type: string; url: string; webSocketDebuggerUrl?: string };
let target: Target | undefined;
const portFile = join(home, "chromium", "DevToolsActivePort");
for (let i = 0; i < 60 && !target; i++) {
	await sleep(1000);
	// Chromium writes the port it picked as the first line of this file.
	const port =
		existsSync(portFile) && readFileSync(portFile, "utf8").split("\n")[0];
	if (!port) continue;
	const targets = (await fetch(`http://127.0.0.1:${port}/json/list`)
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
// reload can't drop them. CDP can attach before <body> exists, so nothing here
// may assume it - a throw there failed boot at once instead of waiting. A control's label is its aria-label, else its
// title, else its text - the rail is icon buttons, Settings is links.
const IN_PAGE = `
	var __label = (e) => (e.getAttribute("aria-label") || e.getAttribute("title") || e.textContent || "").trim();
	var __find = (selector, label, within = document) =>
		[...within.querySelectorAll(selector)].find((e) => __label(e).startsWith(label));
	var __text = () => (document.body?.innerText ?? "").toLowerCase();
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
	const body = await page<string>(`document.body?.innerText ?? ""`);
	for (const crash of ["Something went wrong", "Odin failed to start"]) {
		if (body.includes(crash))
			throw new Error(`"${crash}": ${body.slice(0, 400)}`);
	}
}
const rail = (label: string) => click("button", label);
/** Every time the fake claude ran: its pid and the argv it was given. */
function fakeClaudeRuns() {
	return readdirSync(home)
		.filter((f) => /^claude-\d+\.args$/.test(f))
		.map((f) => ({
			pid: Number(f.match(/\d+/)?.[0]),
			args: readFileSync(join(home, f), "utf8"),
		}));
}
function isAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
/** The end of every session's saved terminal output, for a failure report. */
function terminalTails() {
	const files = Bun.spawnSync([
		"find",
		join(home, ".odin"),
		"-name",
		"scrollback.bin",
	])
		.stdout.toString()
		.split("\n")
		.filter(Boolean);
	return files
		.map((f) =>
			readFileSync(f, "utf8")
				// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
				.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "")
				.slice(-400),
		)
		.join("\n---\n");
}

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
		// CI has no window to look at: say what was on screen and in the PTYs.
		const body = await page<string>(`document.body?.innerText ?? ""`).catch(
			() => "",
		);
		console.log(`     page: ${body.replace(/\s+/g, " ").slice(0, 600)}`);
		const tails = terminalTails();
		if (tails) console.log(`     terminals:\n${tails}`);
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
	["Sessions", "nothing is running"],
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
		"ClickUp",
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
	// The dialog's submit is the last "Add task" - the checklist has one too.
	await page(
		`[...document.querySelectorAll("button")].filter((e) => __label(e) === "Add task").at(-1).click()`,
	);
	await rail("Tasks");
	await waitForText(TASK);
});

await step("the My Tasks composer adds a task with its button", async () => {
	const typed = `Button task ${Date.now()}`;
	await page(`(() => {
		const strip = __find("button", "Slack").parentElement;
		__find("button", "Tasks", strip).click();
	})()`);
	await fill('input[placeholder="What needs doing?"]', typed);
	await click("button", "Add task");
	await waitForText(typed);
});

/**
 * Where TASK's columns sit, and the header's Task label: every tab draws
 * rows with the one table, so the same task lines up the same way on All and
 * on its own tab (task-table.test.ts checks the code; this checks the screen).
 */
const taskColumns = () =>
	page<number[] | null>(`(() => {
		const title = [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === ${JSON.stringify(TASK)});
		const row = title?.closest("[data-task-row]");
		const header = [...document.querySelectorAll("span")].find((e) => e.textContent.trim() === "Task");
		if (!row || !header) return null;
		const x = (e) => Math.round(e?.getBoundingClientRect().left ?? -1);
		return [
			x(header),
			x(title),
			x(row.querySelector('button[aria-label^="Line it up"]')),
			x(row.querySelector('button[aria-label="Start session"], button[aria-label="Go to session"]')),
			x(row.querySelector('button[title="Mark done"]')),
		];
	})()`);

await step(
	"a task's columns line up the same on All and on its own tab",
	async () => {
		await rail("Tasks");
		await waitForText(TASK);
		const all = await taskColumns();
		await page(`(() => {
		const strip = __find("button", "Slack").parentElement;
		__find("button", "Tasks", strip).click();
	})()`);
		await waitForText("my own list");
		await waitForText(TASK);
		const own = await taskColumns();
		if (!all || !own) throw new Error("no table row or header for the task");
		if (all[0] !== all[1] || own[0] !== own[1])
			throw new Error(`the Task header isn't over the titles: ${all} / ${own}`);
		if (JSON.stringify(all) !== JSON.stringify(own))
			throw new Error(`columns moved between All ${all} and Tasks ${own}`);
	},
);

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

await step("starting a task asks for optional context first", async () => {
	await rail("Tasks");
	await waitForText(TASK);
	await click("button", "Start session");
	await click("button", "+ Add context or guidelines (optional)");
	await waitForText("leave it empty to start as is");
	await click("button", "Cancel");
	await waitForText("leave it empty to start as is", false);
	if (fakeClaudeRuns().some((r) => r.args.includes(TASK)))
		throw new Error("Cancel still started a session");
});

/** Click the button titled `title*` on TASK's row in Tasks. */
const clickOnTaskRow = (title: string) =>
	page<boolean>(`(() => {
		const sel = 'button[title^=${JSON.stringify(title)}], button[aria-label^=${JSON.stringify(title)}]';
		let row = [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === ${JSON.stringify(TASK)});
		while (row && !row.querySelector(sel)) row = row.parentElement;
		row?.querySelector(sel).click();
		return !!row;
	})()`);

/** Whether TASK's row has a button titled `title*`. */
const clickOnTaskRowHas = (title: string) =>
	page<boolean>(`(() => {
		const sel = 'button[title^=${JSON.stringify(title)}], button[aria-label^=${JSON.stringify(title)}]';
		let row = [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === ${JSON.stringify(TASK)});
		while (row && !row.querySelector(sel)) row = row.parentElement;
		return !!row?.querySelector(sel) && !!row.querySelector('button[title="Mark done"]');
	})()`);

/**
 * Where Start session and Done sit on TASK's row. Rows are separate grids, so a
 * wider or missing button on one row ("↺ Read later", no Tonight) used to push
 * its buttons out of line with every other row's.
 */
const taskRowButtons = () =>
	page<{ start: number; done: number } | null>(`(() => {
		let row = [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === ${JSON.stringify(TASK)});
		while (row && !row.querySelector('button[title="Mark done"]')) row = row.parentElement;
		const done = row?.querySelector('button[title="Mark done"]')?.getBoundingClientRect();
		const start = [...(row?.querySelectorAll("button") ?? [])].find((e) => /^(Start session|Go to session)/.test(e.getAttribute("aria-label") || e.textContent.trim()))?.getBoundingClientRect();
		return done && start ? { start: Math.round(start.right), done: Math.round(done.left) } : null;
	})()`);

await step("Read later marks a task and keeps it on the list", async () => {
	await rail("Tasks");
	await waitForText(TASK);
	const before = await taskRowButtons();
	if (!before) throw new Error("no Start session and Done on the task's row");
	if (before.done - before.start > 16)
		throw new Error(
			`Start session isn't next to Done: ${before.done - before.start}px apart`,
		);
	if (!(await clickOnTaskRow("Mark it Read later")))
		throw new Error("no Read later button on the task's row");
	// The row's own button turns to "Back to Waiting on you": the Status
	// column that would print "Read later" is hidden on a narrow window.
	for (
		const end = Date.now() + 5_000;
		!(await clickOnTaskRowHas("Back to Waiting on you"));
	) {
		if (Date.now() > end) throw new Error("Read later never took");
		await sleep(200);
	}
	await waitForText(TASK);
	const after = await taskRowButtons();
	if (JSON.stringify(after) !== JSON.stringify(before))
		throw new Error(
			`the wider "↺ Read later" moved the row's buttons: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
		);
	if (!(await clickOnTaskRow("Back to Waiting on you")))
		throw new Error("no way back from Read later on the task's row");
	for (
		const end = Date.now() + 5_000;
		await clickOnTaskRowHas("Back to Waiting on you");
	) {
		if (Date.now() > end) throw new Error("Read later never cleared");
		await sleep(200);
	}
	await waitForText(TASK);
});

await step(
	"Up next lines a task up above the list and lets it go",
	async () => {
		await rail("Tasks");
		if (!(await clickOnTaskRow("Line it up")))
			throw new Error("no Up next button on the task's row");
		await waitForText("drag to reorder");
		await page(
			`document.querySelector('button[title="Take it off Up next"], button[aria-label="Take it off Up next"]')?.click()`,
		);
		await waitForText("drag to reorder", false);
		await waitForText(TASK);
	},
);

await step("Tonight on a task row picks it for the Night Agent", async () => {
	// Next in line is a column you open on the board; a fresh home has it shut.
	const openNextInLine = () =>
		page(
			`document.querySelector('button[title="Show the tasks worth starting next"]')?.click()`,
		);
	await rail("Tasks");
	// One grid column per row item: one short and Done wraps under the checkbox.
	const doneWraps = await page<boolean>(`(() => {
		const title = [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === ${JSON.stringify(TASK)});
		const done = title?.closest("[data-task-row]")?.querySelector('button[title="Mark done"]');
		return !done || done.getBoundingClientRect().top > title.getBoundingClientRect().bottom;
	})()`);
	if (doneWraps) throw new Error("Done wrapped off the task's row");
	if (!(await clickOnTaskRow("Pick for tonight")))
		throw new Error("no Tonight button on the task's row");
	// First pick: the keeps-the-computer-awake notice comes first.
	await waitForText("keeps your computer awake");
	await click("button", "Got it");
	await rail("Dev Board");
	await openNextInLine();
	await waitForText("tonight · 1");
	await rail("Tasks");
	if (!(await clickOnTaskRow("Take off tonight")))
		throw new Error("Tonight didn't toggle back on the task's row");
	await rail("Dev Board");
	await openNextInLine();
	await waitForText("click the moon on a task to run it tonight");
	// Leave the board as the later steps expect it.
	await page(
		`document.querySelector('button[title="Hide the Next in line column"]')?.click()`,
	);
});

await step("the Tasks page has its own composer", async () => {
	const typed = `All composer task ${Date.now()}`;
	await rail("Tasks");
	await fill('input[placeholder="What needs doing?"]', typed);
	await click("button", "Add task");
	await waitForText(typed);
});

await step("ticking two tasks marks both done at once", async () => {
	const pair = [`Bulk one ${Date.now()}`, `Bulk two ${Date.now()}`];
	await rail("Tasks");
	for (const typed of pair) {
		await fill('input[placeholder="What needs doing?"]', typed);
		await click("button", "Add task");
		await waitForText(typed);
	}
	for (const typed of pair)
		await page(
			`document.querySelector(${JSON.stringify(`input[aria-label="Select ${typed}"]`)}).click()`,
		);
	await waitForText("2 selected");
	// The bar's Done, not a row's: the bar is the element that says "selected".
	await page(`(() => {
		let bar = [...document.querySelectorAll("span")].find((e) => e.textContent.trim() === "2 selected");
		while (bar && !bar.querySelector('button[title="Mark done"]')) bar = bar.parentElement;
		bar.querySelector('button[title="Mark done"]').click();
	})()`);
	for (const typed of pair) await waitForText(typed, false);
	await waitForText("2 selected", false);
	await waitForText(TASK);
});

await step("A task's title opens its details beside the list", async () => {
	await rail("Tasks");
	await waitForText(TASK);
	// Its label is its title, "Show details"; match on the task text instead.
	await page(
		`[...document.querySelectorAll("button")].find((e) => e.textContent.trim() === ${JSON.stringify(TASK)})?.click()`,
	);
	await waitForText("Tasks feed →");
	const hash = await page<string>("location.hash");
	if (!hash.startsWith("#/all")) throw new Error(`title click opened ${hash}`);
	// Renaming lives in the panel; the row picks the new name up. Empty restores.
	// focusout by hand: blur() fires nothing in an unfocused CI window, and
	// focusout is what React's onBlur listens to.
	const rename = (to: string) =>
		page(`(() => {
			const box = document.querySelector('textarea[title^="Rename"]');
			box.value = ${JSON.stringify(to)};
			box.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		})()`);
	await rename("Renamed in the panel");
	await waitForText("Renamed in the panel");
	await rename("");
	await waitForText("Renamed in the panel", false);
	await waitForText(TASK);
	await click("button", "Close details");
	await waitForText("Tasks feed →", false);
});

await step("⌘⇧F Search all finds a task and opens its details", async () => {
	await rail("Dev Board");
	await waitForText("next in line");
	await page(`document.activeElement?.blur()`);
	await page(
		`document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", metaKey: true, shiftKey: true, bubbles: true }))`,
	);
	await sleep(300);
	await fill(
		'input[placeholder="Search feeds, the board and every past session"]',
		TASK,
	);
	// The board can show the task too: wait for it as the palette's picked hit.
	const picked = `document.querySelector('[cmdk-item][data-selected="true"]')?.textContent.includes(${JSON.stringify(TASK)})`;
	for (const end = Date.now() + 5_000; !(await page<boolean>(picked)); ) {
		if (Date.now() > end) throw new Error("the task never came up first");
		await sleep(200);
	}
	// Enter picks it, the way the keyboard would.
	await page(
		`document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }))`,
	);
	await waitForText("Tasks feed →");
	const hash = await page<string>("location.hash");
	if (!hash.startsWith("#/all")) throw new Error(`Search all opened ${hash}`);
	await click("button", "Close details");
	await waitForText("Tasks feed →", false);
});

await step("Done takes a task off the list", async () => {
	await rail("Tasks");
	await waitForText(TASK);
	// The title button's text is the task itself; match on that.
	const found = await page<boolean>(`(() => {
		let row = [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === ${JSON.stringify(TASK)});
		while (row && !row.querySelector('button[title="Mark done"]')) row = row.parentElement;
		row?.querySelector('button[title="Mark done"]').click();
		return !!row;
	})()`);
	if (!found) throw new Error("no Done button on the task's row");
	await waitForText(TASK, false);
});

// Settings is eight fixed screens; each sidebar link and the route it opens.
const SETTINGS: [string, string][] = [
	["Connections", "#/settings/connections"],
	["Sessions", "#/settings/sessions"],
	["Storage", "#/settings/storage"],
	["Backlog & Night Agent", "#/settings/backlog"],
	["Notifications", "#/settings/ringtones"],
	["Appearance", "#/settings/appearance"],
	["Keyboard", "#/settings/keyboard"],
	["Advanced", "#/settings/advanced"],
];
await step("Settings: exactly its eight screens, and each opens", async () => {
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
	// Keyboard's search narrows the list.
	await click("a", "Keyboard");
	await fill('input[aria-label="Search shortcuts"]', "undo");
	await waitForText("next session", false);
	await waitForText("undo the last done");
	await fill('input[aria-label="Search shortcuts"]', "");
	await click("a", "Back");
	await waitForText("waiting on you");
});

await step("The raven opens its panel in place", async () => {
	await rail("Dev Board");
	await waitForText("next in line");
	await click("button", "Ask the raven");
	// The left-open conversation's Claude died with the last run, so the panel
	// greets; asking would resume it there.
	await waitForText("how can i help you today?");
	await click("button", "Ask the raven");
	await waitForText("how can i help you today?", false);
});

const SESSION = `Smoke session ${Date.now()}`;
let sessionPid = 0;
await step(
	"New Session puts a card on the board and gives claude the prompt",
	async () => {
		// Esc first, so nothing an earlier step opened is in the way.
		await page(
			`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
		);
		await rail("Dev Board");
		await waitForText("next in line");
		await click("button", "Describe a task and start an agent session");
		await fill('textarea[placeholder^="What should the agent do?"]', SESSION);
		await click("button", "Start session");
		await waitForText(SESSION, true, 30_000);
		// A busy machine (a CI runner right after the build) queues the launch;
		// the card's Start now is how a person gets past the gate.
		await sleep(2000);
		await page(
			`document.querySelector('button[title="Start this session now, gate or no gate"]')?.click()`,
		);
		// The crow keeps its own claude warm, so pick out the run that
		// carries this session's prompt.
		for (const end = Date.now() + 60_000; !sessionPid; await sleep(500)) {
			if (Date.now() > end) {
				const runs = fakeClaudeRuns().map((r) => r.args.replace(/\n/g, " "));
				throw new Error(`no claude got the prompt; runs: ${runs.join(" | ")}`);
			}
			const run = fakeClaudeRuns().find((r) => r.args.includes(SESSION));
			if (run && !run.args.includes("--session-id"))
				throw new Error(`claude ran without --session-id: ${run.args}`);
			sessionPid = run?.pid ?? 0;
		}
	},
);

await step("an agent's command runs in its session's own Shell", async () => {
	// What the launch prompt tells the agent to do, done as the agent would.
	const [port, paneId] = readFileSync(join(home, `pane-${sessionPid}`), "utf8")
		.trim()
		.split(" ");
	const ran = join(home, "shell-ran");
	const response = await fetch(`http://127.0.0.1:${port}/shell/run`, {
		method: "POST",
		body: new URLSearchParams({
			paneId,
			command: `echo "$ODIN_PANE_ID" > '${ran}'`,
		}),
	});
	if (!response.ok)
		throw new Error(`${response.status} ${await response.text()}`);
	for (const end = Date.now() + 15_000; !existsSync(ran); await sleep(250)) {
		if (Date.now() > end) throw new Error("the command never ran");
	}
	const shell = readFileSync(ran, "utf8").trim();
	if (!shell || shell === paneId)
		throw new Error(`ran in "${shell}", not a Shell pane of its own`);
	// …and it's the pane the card's ❯ Shell opens.
	const shellOf = () =>
		JSON.parse(readFileSync(join(home, ".odin", "app-state.json"), "utf8"))
			.tabsState?.panes?.[paneId]?.odinShellPaneId;
	for (const end = Date.now() + 10_000; shellOf() !== shell; await sleep(250)) {
		if (Date.now() > end)
			throw new Error(`the card's Shell is ${shellOf()}, not ${shell}`);
	}
});

await step(
	"Done on the card ends the session and clears the board",
	async () => {
		const found = await page<boolean>(`(() => {
		const done = [...document.querySelectorAll('button[title="Done - remove from the board"]')]
			.find((b) => b.parentElement.textContent.includes(${JSON.stringify(SESSION)}));
		done?.click();
		return !!done;
	})()`);
		if (!found) throw new Error("no Done button on the session's card");
		await waitForText(SESSION, false);
		if (!sessionPid) throw new Error("the session's claude never started");
		for (
			const end = Date.now() + 15_000;
			isAlive(sessionPid);
			await sleep(250)
		) {
			if (Date.now() > end)
				throw new Error(`claude (pid ${sessionPid}) still running`);
		}
	},
);

await step("⌘Z after Done resumes the session onto the board", async () => {
	await page(`document.activeElement?.blur()`);
	await page(
		`document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", metaKey: true, bubbles: true }))`,
	);
	await waitForText(SESSION, true, 30_000);
	for (const end = Date.now() + 30_000; ; await sleep(500)) {
		if (fakeClaudeRuns().some((r) => r.args.includes("--resume"))) break;
		if (Date.now() > end) throw new Error("no claude --resume ran");
	}
});

await step("no uncaught errors in the renderer", async () => {
	if (exceptions.length) throw new Error(exceptions.join("\n     "));
});

console.log(
	failures.length ? `\n${failures.length} flow(s) broken` : "\nall flows pass",
);
await quit(failures.length ? 1 : 0);
