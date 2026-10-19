/**
 * Screenshots of the real app for the website (site/shots), with sample data.
 *
 *   bun run compile:app && bun run site-shots        # from apps/desktop
 *
 * Boots dist/ in a throwaway home exactly the way smoke.ts does (HOME,
 * ODIN_HOME_DIR, TMPDIR and the Chromium profile in a fresh /tmp dir, a fake
 * `claude`, ODIN_SMOKE=1 so the window never takes focus), starts sample
 * sessions, moves each to its column with the same lifecycle hooks a real
 * agent sends, writes the queue down, and saves board.png, session.png and
 * queue.png at 1600x1000, 2x. Nothing here names a real person or company.
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
const OUT = join(APP_DIR, "..", "..", "site", "shots");
mkdirSync(OUT, { recursive: true });

// Short root: Darwin caps a unix socket path at 104 bytes.
const home = mkdtempSync("/tmp/odin-shots-");
const env: Record<string, string | undefined> = {
	...process.env,
	HOME: home,
	ODIN_HOME_DIR: join(home, ".odin"),
	TMPDIR: home,
	NODE_ENV: "production",
	ODIN_SMOKE: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.ODIN_CONFIG_PATH;
delete env.ZDOTDIR;
mkdirSync(join(home, ".odin"));

// The checkout sessions start in: its folder name is the repo on each card.
const repo = join(home, "dev", "api");
mkdirSync(repo, { recursive: true });
writeFileSync(
	join(home, ".gitconfig"),
	"[user]\n\tname = Sample\n\temail = sample@odin.local\n",
);
for (const args of [
	["init", "-q", "-b", "main"],
	["commit", "-q", "--allow-empty", "-m", "init"],
])
	Bun.spawnSync(["git", "-C", repo, ...args], { env: { ...env } });
env.DAN_DEFAULT_REPO = repo;

// A stand-in for Claude Code (smoke.ts's): it records its argv and pane, leaves
// an empty transcript for its --session-id, and stays alive like a working agent.
mkdirSync(join(home, "bin"));
writeFileSync(
	join(home, "bin", "claude"),
	`#!/bin/sh\nfor a; do [ "$prev" = --session-id ] && mkdir -p "$HOME/.claude/projects/sample" && : > "$HOME/.claude/projects/sample/$a.jsonl"; prev=$a; done\nprintf '%s %s' "$ODIN_PORT" "$ODIN_PANE_ID" > "$HOME/pane-$$"\nprintf '%s\\n' "$@" > "$HOME/.claude-$$"\nmv "$HOME/.claude-$$" "$HOME/claude-$$.args"\necho "Reading the code..."\ntrap 'kill $!; exit 0' TERM\nsleep 900 & wait\n`,
	{ mode: 0o755 },
);
env.PATH = `${join(home, "bin")}:${env.PATH}`;
for (const profile of [".zprofile", ".bash_profile"])
	writeFileSync(join(home, profile), 'export PATH="$HOME/bin:$PATH"\n');

const app = spawn(
	electronBinary as unknown as string,
	[
		APP_DIR,
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
	// The daemons outlive the app by design; whatever holds a file under the
	// throwaway home is one of them.
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
	console.error("FAIL timed out\n", appLog.slice(-4000));
	void quit(1);
}, 300_000).unref();

// --- CDP (smoke.ts's) ----------------------------------------------------------
type Target = { type: string; url: string; webSocketDebuggerUrl?: string };
let target: Target | undefined;
const portFile = join(home, "chromium", "DevToolsActivePort");
for (let i = 0; i < 60 && !target; i++) {
	await sleep(1000);
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

const IN_PAGE = `
	var __label = (e) => (e.getAttribute("aria-label") || e.getAttribute("title") || e.textContent || "").trim();
	var __find = (selector, label, within = document) =>
		[...within.querySelectorAll(selector)].find((e) => __label(e).startsWith(label));
	var __text = () => (document.body?.innerText ?? "").toLowerCase();
`;
async function page<T>(expression: string): Promise<T> {
	const { result, exceptionDetails } = await send("Runtime.evaluate", {
		expression: `${IN_PAGE}\n${expression}`,
		returnByValue: true,
		awaitPromise: true,
	});
	if (exceptionDetails) throw new Error(exceptionDetails.text);
	return result?.value as T;
}
async function click(selector: string, label: string) {
	const found = await page<boolean>(
		`(() => { const e = __find(${JSON.stringify(selector)}, ${JSON.stringify(label)}); e?.click(); return !!e; })()`,
	);
	if (!found) throw new Error(`no ${selector} labelled "${label}"`);
	await sleep(400);
}
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
const pressEscape = () =>
	page(
		`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
	);
const rail = (label: string) => click("button", label);
function fakeClaudeRuns() {
	return readdirSync(home)
		.filter((f) => /^claude-\d+\.args$/.test(f))
		.map((f) => ({
			pid: Number(f.match(/\d+/)?.[0]),
			args: readFileSync(join(home, f), "utf8"),
		}));
}

/** The whole window at 1600x1000, drawn at 2x. */
async function shoot(name: string) {
	await sleep(1200);
	const { data } = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(join(OUT, name), Buffer.from(data ?? "", "base64"));
	console.log(`saved site/shots/${name}`);
}

// --- the sample --------------------------------------------------------------
type Sample = {
	title: string;
	/** The hooks a real agent would have sent, in order. */
	hooks: string[];
	star?: boolean;
	/** The agent exited: the card waits in Idle to be resumed. */
	ended?: boolean;
};
const SESSIONS: Sample[] = [
	{
		title: "Old flaky CI run on the deploy job",
		hooks: ["Start"],
		ended: true,
	},
	{ title: "Pricing page copy from Maya's doc", hooks: ["Start", "Stop"] },
	{ title: "PAY-212 CSV export stuck at 99%", hooks: ["Start"] },
	{
		title: "Search ranking ignores exact matches",
		hooks: ["Start"],
		star: true,
	},
	{ title: "Review the rate limiter PR", hooks: ["Start"] },
	{ title: "Settings menu cleanup", hooks: ["Start", "PermissionRequest"] },
	{
		title: "Fix flaky upload test",
		hooks: ["Start", "PermissionRequest"],
		star: true,
	},
];
const TASKS = [
	"Rotate the staging database password",
	"Answer Maya about the onboarding emails",
	"Bump the image library and check the thumbnails",
	"Write the release notes for 2.4",
	"Look into slow search on large accounts",
];

try {
	await waitForText("next in line", true, 60_000);
	await send("Emulation.setDeviceMetricsOverride", {
		width: 1600,
		height: 1000,
		deviceScaleFactor: 2,
		mobile: false,
	});

	// The queue: tasks written down in My Tasks' composer.
	await rail("Tasks");
	await waitForText("waiting on you");
	await page(`(() => {
		const strip = __find("button", "Slack").parentElement;
		__find("button", "Tasks", strip).click();
	})()`);
	await sleep(400);
	for (const task of TASKS) {
		await fill('input[placeholder="What needs doing?"]', task);
		await click("button", "Add task");
		await waitForText(task);
	}
	await rail("Dev Board");
	await waitForText("next in line");

	// The sessions, each on the fake claude.
	const panes = new Map<
		string,
		{ pid: number; port: string; paneId: string }
	>();
	for (const sample of SESSIONS) {
		await pressEscape();
		await click("button", "Describe a task and start an agent session");
		await fill(
			'textarea[placeholder^="What should the agent do?"]',
			sample.title,
		);
		await click("button", "Start session");
		await waitForText(sample.title.slice(0, 20), true, 30_000);
		let pid = 0;
		for (const end = Date.now() + 60_000; !pid; await sleep(500)) {
			if (Date.now() > end) throw new Error(`no claude for ${sample.title}`);
			// Past the machine's launch gate, the way a person would.
			await page(
				`document.querySelector('button[title="Start this session now, gate or no gate"]')?.click()`,
			);
			pid =
				fakeClaudeRuns().find((r) => r.args.includes(sample.title))?.pid ?? 0;
		}
		for (
			const end = Date.now() + 10_000;
			!existsSync(join(home, `pane-${pid}`));
		)
			if (Date.now() > end) break;
			else await sleep(200);
		const [port, paneId] = readFileSync(join(home, `pane-${pid}`), "utf8")
			.trim()
			.split(" ");
		panes.set(sample.title, { pid, port, paneId });
	}

	// Each to its column, as its agent's hooks would put it.
	for (const sample of SESSIONS) {
		const pane = panes.get(sample.title);
		if (!pane) continue;
		for (const eventType of sample.hooks) {
			await fetch(
				`http://127.0.0.1:${pane.port}/hook/complete?${new URLSearchParams({ paneId: pane.paneId, eventType })}`,
			);
			await sleep(150);
		}
		if (sample.ended) process.kill(pane.pid, "SIGTERM");
	}

	// Stars, from each card's own star button.
	for (const sample of SESSIONS.filter((s) => s.star)) {
		await page(`(() => {
			let card = [...document.querySelectorAll("*")].find((e) => e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(sample.title)});
			while (card && !card.querySelector('button[title^="Star"], button[aria-label^="Star"]')) card = card.parentElement;
			card?.querySelector('button[title^="Star"], button[aria-label^="Star"]')?.click();
		})()`);
	}

	await pressEscape();
	await rail("Dev Board");
	await waitForText("next in line");
	// A first-run checklist, not the board.
	await page(
		`document.querySelector('button[aria-label="Close Get started"]')?.click()`,
	);
	// The ended session leaves Working once the daemon poll sees it gone.
	await sleep(6000);
	await shoot("board.png");

	// One session's conversation, as Claude Code writes it.
	const open = SESSIONS.find((s) => s.title === "Fix flaky upload test");
	const openPane = open && panes.get(open.title);
	const sessionId = openPane
		? fakeClaudeRuns()
				.find((r) => r.pid === openPane.pid)
				?.args.split("\n")
				.find((_a, i, all) => all[i - 1] === "--session-id")
		: undefined;
	if (sessionId) {
		const at = (min: number) =>
			new Date(Date.now() - min * 60_000).toISOString();
		const user = (text: string, min: number) => ({
			type: "user",
			promptSource: "typed",
			cwd: repo,
			sessionId,
			timestamp: at(min),
			message: { role: "user", content: text },
		});
		const assistant = (text: string, min: number) => ({
			type: "assistant",
			cwd: repo,
			sessionId,
			timestamp: at(min),
			message: { role: "assistant", content: [{ type: "text", text }] },
		});
		const lines = [
			user("Fix flaky upload test", 42),
			assistant(
				"Looking at the upload tests. `uploads.test.ts` fails about 1 run in 5 on CI and never locally.",
				40,
			),
			assistant(
				[
					"Found it. The test uploads three files in parallel and asserts their order, but the server stores them in the order they finish, not the order they were sent. On a busy CI runner the small file often wins.",
					"",
					"I changed the test to sort by file name before comparing, and added a test that the server keeps the client's order when `ordered: true` is set. 38 tests pass, 20 runs in a row.",
					"",
					"ACTION ITEMS",
					"1. Approve running the migration that adds the `position` column on staging",
					"2. Tell me which branch to push to: main / release",
					"3. Check the PR when it's open",
				].join("\n"),
				2,
			),
		];
		// Where Claude files it: under its start cwd, every non-alphanumeric a "-".
		rmSync(join(home, ".claude", "projects", "sample", `${sessionId}.jsonl`), {
			force: true,
		});
		const dir = join(
			home,
			".claude",
			"projects",
			repo.replace(/[^A-Za-z0-9]/g, "-"),
		);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${sessionId}.jsonl`),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
		);
		await page(`(() => {
			const title = [...document.querySelectorAll("*")].find((e) => e.childElementCount === 0 && e.textContent.trim() === "Fix flaky upload test");
			title?.click();
		})()`);
		await waitForText("found it", true, 20_000).catch(() => {});
		await shoot("session.png");
		await pressEscape();
	} else console.log("skip session.png: no session id for the sample");

	await rail("Tasks");
	await waitForText(TASKS[0] ?? "");
	await shoot("queue.png");
	await quit(0);
} catch (error) {
	console.error(`FAIL ${(error as Error).message}\n`, appLog.slice(-2000));
	await quit(1);
}
