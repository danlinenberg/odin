/**
 * The demo video on the website (site/demo.webm and site/demo.jpg), recorded
 * from the real app with sample data.
 *
 *   bun run compile:app && bun run site-demo        # from apps/desktop
 *
 * Boots dist/ in a throwaway home the way site-shots.ts does, then plays a
 * short script: tasks go into the queue, one becomes a session, sessions move
 * across the board as their hooks arrive, a session's chat with its action
 * items, and Search All. A drawn cursor and a caption per step make it readable without
 * sound. CDP's screencast gives the frames; ffmpeg (FFMPEG, or Playwright's
 * build, which has the VP9 encoder) turns them into a 1600x1000 webm, and an
 * ffmpeg with libx264 (FFMPEG_MP4, or `ffmpeg` on PATH) into the H.264 mp4
 * Safari and QuickTime play.
 * Nothing here names a real person or company.
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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import electronBinary from "electron";

const APP_DIR = join(import.meta.dir, "..");
const OUT = join(APP_DIR, "..", "..", "site");
const WIDTH = 1600;
const HEIGHT = 1000;
const FPS = 30;

function findFfmpeg(): string {
	if (process.env.FFMPEG) return process.env.FFMPEG;
	const cache = join(homedir(), ".cache", "ms-playwright");
	const dir =
		existsSync(cache) &&
		readdirSync(cache)
			.filter((d) => d.startsWith("ffmpeg-"))
			.sort()
			.pop();
	if (dir)
		for (const bin of ["ffmpeg-linux", "ffmpeg-mac", "ffmpeg-win64.exe"])
			if (existsSync(join(cache, dir, bin))) return join(cache, dir, bin);
	return "ffmpeg";
}
const FFMPEG = findFfmpeg();

// Short root: Darwin caps a unix socket path at 104 bytes.
const home = mkdtempSync("/tmp/odin-demo-");
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
		// A Linux box with no display: Chromium draws offscreen.
		...(process.platform === "linux" && !process.env.DISPLAY
			? ["--ozone-platform=headless", "--no-sandbox"]
			: []),
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
}, 600_000).unref();

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
type CdpEvent = {
	method: string;
	params: { data: string; sessionId: number; metadata: { timestamp: number } };
};
const frames: { at: number; jpeg: Buffer }[] = [];
ws.onmessage = (e) => {
	const m = JSON.parse(String(e.data));
	if (m.method === "Page.screencastFrame") {
		const { params } = m as CdpEvent;
		frames.push({
			at: params.metadata.timestamp,
			jpeg: Buffer.from(params.data, "base64"),
		});
		void send("Page.screencastFrameAck", { sessionId: params.sessionId });
		return;
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
await send("Page.enable");

const IN_PAGE = `
	var __label = (e) => (e.getAttribute("aria-label") || e.getAttribute("title") || e.textContent || "").trim();
	var __find = (selector, label, within = document) =>
		[...within.querySelectorAll(selector)].find((e) => __label(e).startsWith(label));
	var __text = () => (document.body?.innerText ?? "").toLowerCase();
	var __leaf = (text) => [...document.querySelectorAll("*")].find((e) => e.childElementCount === 0 && e.textContent.trim() === text);
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
async function click(selector: string, label: string) {
	const found = await page<boolean>(
		`(() => { const e = __find(${JSON.stringify(selector)}, ${JSON.stringify(label)}); e?.click(); return !!e; })()`,
	);
	if (!found) throw new Error(`no ${selector} labelled "${label}"`);
	await sleep(400);
}
async function fill(selector: string, value: string) {
	for (const end = Date.now() + 5000; ; await sleep(200)) {
		const found = await page<boolean>(`(() => {
			const el = document.querySelector(${JSON.stringify(selector)});
			if (!el) return false;
			el.focus();
			Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set.call(el, ${JSON.stringify(value)});
			el.dispatchEvent(new Event("input", { bubbles: true }));
			return true;
		})()`);
		if (found) return;
		if (Date.now() > end) throw new Error(`no field ${selector}`);
	}
}
function isAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
function sessionIdOf(args: string) {
	return args
		.split("\n")
		.find((_a, i, all) => /^--(session-id|resume)$/.test(all[i - 1] ?? ""));
}
function fakeClaudeRuns() {
	return readdirSync(home)
		.filter((f) => /^claude-\d+\.args$/.test(f))
		.map((f) => ({
			pid: Number(f.match(/\d+/)?.[0]),
			args: readFileSync(join(home, f), "utf8"),
		}));
}

// --- the cursor and the captions ------------------------------------------------
// Drawn into the page, above everything, deaf to the mouse.
const OVERLAY = `(() => {
	if (document.getElementById("__demo-cursor")) return;
	const style = document.createElement("style");
	style.textContent = \`
		#__demo-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
			width: 22px; height: 22px; transform: translate(800px, 600px);
			transition: transform 700ms cubic-bezier(.45,.05,.25,1); }
		#__demo-cursor svg { filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
		#__demo-cursor.press::after { content: ""; position: absolute; left: -14px; top: -14px; width: 28px; height: 28px;
			border-radius: 50%; background: rgba(168,140,255,.45); animation: __demo-ping 450ms ease-out forwards; }
		@keyframes __demo-ping { from { transform: scale(.4); opacity: 1 } to { transform: scale(1.6); opacity: 0 } }
		#__demo-caption { position: fixed; left: 50%; bottom: 36px; z-index: 2147483646; pointer-events: none;
			transform: translate(-50%, 12px); opacity: 0; transition: opacity 350ms, transform 350ms;
			padding: 12px 22px; border-radius: 12px; background: rgba(14,12,22,.88); color: #f4f2ff;
			font: 600 22px/1.3 Geist, -apple-system, system-ui, sans-serif; letter-spacing: -.01em;
			box-shadow: 0 10px 30px rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.08); white-space: nowrap; }
		#__demo-caption.on { opacity: 1; transform: translate(-50%, 0); }
	\`;
	document.head.append(style);
	const cursor = document.createElement("div");
	cursor.id = "__demo-cursor";
	cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l16 10.5-7 1.3 4.2 7.4-2.8 1.5-4.2-7.4L5 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
	const caption = document.createElement("div");
	caption.id = "__demo-caption";
	document.body.append(cursor, caption);
})()`;

async function caption(text: string) {
	if (text) console.log(`> ${text}`);
	await page(`(() => {
		const el = document.getElementById("__demo-caption");
		el.classList.remove("on");
		setTimeout(() => { el.textContent = ${JSON.stringify(text)}; el.classList.add("on"); }, ${text ? 250 : 0});
	})()`);
}

/** Glide the cursor to the element `find` returns, then click it. */
async function clickOn(find: string, { press = true } = {}) {
	const found = await page<boolean>(`(() => {
		const el = (${find})();
		if (!el) return false;
		el.scrollIntoView({ block: "nearest" });
		const r = el.getBoundingClientRect();
		document.getElementById("__demo-cursor").style.transform =
			"translate(" + (r.left + Math.min(r.width / 2, 60)) + "px," + (r.top + r.height / 2) + "px)";
		return true;
	})()`);
	if (!found) throw new Error(`nothing for ${find}`);
	await sleep(850);
	if (!press) return;
	await page(`(() => {
		const c = document.getElementById("__demo-cursor");
		c.classList.remove("press"); void c.offsetWidth; c.classList.add("press");
		(${find})()?.click();
	})()`);
	await sleep(500);
}
const button = (label: string, within = "document") =>
	`() => __find("button", ${JSON.stringify(label)}, ${within})`;

/** Types into a field a few characters at a time, the way a person would. */
async function type(selector: string, value: string) {
	const step = Math.max(1, Math.ceil(value.length / 22));
	for (let i = step; ; i += step) {
		const shown = value.slice(0, Math.min(i, value.length));
		await page(`(() => {
			const el = document.querySelector(${JSON.stringify(selector)});
			el.focus();
			Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set.call(el, ${JSON.stringify(shown)});
			el.dispatchEvent(new Event("input", { bubbles: true }));
		})()`);
		await sleep(45);
		if (shown.length === value.length) return;
	}
}

// --- the sample --------------------------------------------------------------
type Sample = {
	title: string;
	/** The hooks a real agent sends, in order, as the video plays. */
	hooks: string[];
	star?: boolean;
};
const SESSIONS: Sample[] = [
	{ title: "Pricing page copy from the product doc", hooks: ["Start", "Stop"] },
	{ title: "PAY-212 CSV export stuck at 99%", hooks: ["Start"] },
	{
		title: "Search ranking ignores exact matches",
		hooks: ["Start"],
		star: true,
	},
	{ title: "Review the rate limiter PR", hooks: ["Start"] },
	{ title: "Settings menu cleanup", hooks: ["Start", "PermissionRequest"] },
];
const HERO = "Fix flaky upload test";
const TASKS = [
	HERO,
	"Rotate the staging database password",
	"Bump the image library and check the thumbnails",
	"Write the release notes for 2.4",
];

const panes = new Map<string, { pid: number; port: string; paneId: string }>();
async function waitForClaude(title: string) {
	let pid = 0;
	for (const end = Date.now() + 60_000; !pid; await sleep(300)) {
		if (Date.now() > end) throw new Error(`no claude for ${title}`);
		// Past the machine's launch gate, the way a person would.
		await page(
			`document.querySelector('button[title="Start this session now, gate or no gate"]')?.click()`,
		);
		// The session's own run, still alive: Odin's side runs (a brief, a
		// title) carry the same words and exit at once, and a pane that remounts
		// as the session opens comes back as a --resume of the same session.
		const runs = fakeClaudeRuns();
		const ids = runs
			.filter((r) => r.args.includes(title))
			.map((r) => sessionIdOf(r.args))
			.filter(Boolean);
		pid =
			runs.find(
				(r) =>
					isAlive(r.pid) &&
					ids.includes(sessionIdOf(r.args)) &&
					!panes.has(title),
			)?.pid ?? 0;
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
	panes.set(title, { pid, port, paneId });
}
async function hook(title: string, eventType: string) {
	const pane = panes.get(title);
	if (!pane) return;
	await fetch(
		`http://127.0.0.1:${pane.port}/hook/complete?${new URLSearchParams({ paneId: pane.paneId, eventType })}`,
	);
}
async function startSession(title: string) {
	console.log(`start ${title}`);
	await pressEscape();
	await click("button", "Describe a task and start an agent session");
	await fill('textarea[placeholder^="What should the agent do?"]', title);
	await click("button", "Start session");
	await waitForText(title.slice(0, 20), true, 30_000);
	await waitForClaude(title);
}

/** One session's conversation, as Claude Code writes it. */
function writeTranscript(title: string) {
	const pane = panes.get(title);
	const run = pane && fakeClaudeRuns().find((r) => r.pid === pane.pid);
	const sessionId = run && sessionIdOf(run.args);
	if (!sessionId) throw new Error(`no session id for ${title}`);
	const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
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
		user(title, 6),
		assistant(
			"Looking at the upload tests. `uploads.test.ts` fails about 1 run in 5 on CI and never locally.",
			5,
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
			0,
		),
	];
	// Where Claude files it (under its start cwd, every non-alphanumeric a "-"),
	// and over the empty one the fake claude left, which Odin may have found first.
	for (const folder of ["sample", repo.replace(/[^A-Za-z0-9]/g, "-")]) {
		const dir = join(home, ".claude", "projects", folder);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${sessionId}.jsonl`),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
		);
	}
}

/** Frames at a steady FPS, each screencast frame held until the next one. */
function encode(from: number, to: number) {
	const kept = frames.filter((f) => f.at <= to);
	const start = kept.findLastIndex((f) => f.at <= from);
	const clip = kept.slice(Math.max(0, start));
	const out = join(OUT, "demo.webm");
	const ffmpeg = Bun.spawn(
		[
			FFMPEG,
			"-loglevel",
			"error",
			"-y",
			"-f",
			"image2pipe",
			"-c:v",
			"mjpeg",
			"-framerate",
			String(FPS),
			"-i",
			"pipe:0",
			"-vf",
			`scale=${WIDTH}:${HEIGHT}`,
			"-c:v",
			"libvpx-vp9",
			"-b:v",
			"0",
			"-crf",
			"34",
			"-deadline",
			"good",
			"-cpu-used",
			"2",
			"-row-mt",
			"1",
			"-an",
			out,
		],
		{ stdin: "pipe", stderr: "inherit" },
	);
	let i = 0;
	for (let t = from; t <= to; t += 1 / FPS) {
		while (i + 1 < clip.length && (clip[i + 1]?.at ?? Infinity) <= t) i++;
		const frame = clip[i];
		if (frame) ffmpeg.stdin.write(frame.jpeg);
	}
	ffmpeg.stdin.end();
	return ffmpeg.exited;
}

try {
	await waitForText("next in line", true, 120_000);
	console.log("app is up");
	await send("Emulation.setDeviceMetricsOverride", {
		width: WIDTH,
		height: HEIGHT,
		deviceScaleFactor: 1,
		mobile: false,
	});
	// A first-run checklist, not the board.
	await page(
		`document.querySelector('button[aria-label="Close Get started"]')?.click()`,
	);

	// Off camera: the sessions already running when the video starts.
	for (const sample of SESSIONS) await startSession(sample.title);
	for (const sample of SESSIONS) await hook(sample.title, "Start");
	for (const sample of SESSIONS.filter((s) => s.star))
		await page(`(() => {
			let card = __leaf(${JSON.stringify(sample.title)});
			while (card && !card.querySelector('button[title^="Star"], button[aria-label^="Star"]')) card = card.parentElement;
			card?.querySelector('button[title^="Star"], button[aria-label^="Star"]')?.click();
		})()`);
	// And the queue, written down in My Tasks.
	await pressEscape();
	await click("button", "Tasks");
	await waitForText("waiting on you");
	await page(`(() => {
		const strip = __find("button", "Slack").parentElement;
		__find("button", "Tasks", strip).click();
	})()`);
	await sleep(400);
	for (const task of [...TASKS].reverse()) {
		await fill('textarea[placeholder="What needs doing?"]', task);
		await click("button", "Add task");
		await waitForText(task);
	}
	await click("button", "Dev Board");
	await waitForText("next in line");
	await sleep(1500);
	await page(OVERLAY);

	// --- on camera -------------------------------------------------------------
	await send("Page.startScreencast", {
		format: "jpeg",
		quality: 88,
		maxWidth: WIDTH,
		maxHeight: HEIGHT,
	});
	await sleep(600);
	const from = frames.at(-1)?.at ?? Date.now() / 1000;

	await caption("Every agent on one board, sorted by what it's doing");
	await sleep(2200);
	for (const sample of SESSIONS)
		for (const eventType of sample.hooks.slice(1)) {
			await hook(sample.title, eventType);
			await sleep(900);
		}
	await sleep(1800);
	// The poster: the board with every column filled, before the cursor moves on.
	const posterAt = Date.now() / 1000;

	await caption("Slack, Jira, GitHub and your own tasks, in one queue");
	await clickOn(button("Tasks"));
	await waitForText(HERO);
	await sleep(2200);

	await caption("One click hands a task to an agent");
	await clickOn(`() => __leaf(${JSON.stringify(HERO)})`, { press: false });
	await sleep(600);
	const START = `button[aria-label="Start session"]`;
	await clickOn(`() => {
		let row = __leaf(${JSON.stringify(HERO)});
		while (row && !row.querySelector('${START}')) row = row.parentElement;
		return row?.querySelector('${START}');
	}`);
	await sleep(700);
	// The launch dialog: one big Start, context optional.
	await clickOn(
		`() => [...document.querySelectorAll("button")].find((b) => !b.hasAttribute("aria-label") && b.textContent.trim() === "Start session")`,
	);
	await waitForClaude(HERO);
	await sleep(1200);
	await clickOn(button("Dev Board"));
	await waitForText(HERO, true, 15_000);
	await sleep(1500);

	await caption("Odin pings you the moment one needs you");
	await hook(HERO, "Start");
	await sleep(1000);
	writeTranscript(HERO);
	await hook(HERO, "PermissionRequest");
	await sleep(2600);

	await caption("Each reply ends with your action items");
	await clickOn(`() => __leaf(${JSON.stringify(HERO)})`);
	await waitForText("found it", true, 20_000).catch(() => {});
	await sleep(4200);

	await caption("Search every row, card and past conversation at once");
	await pressEscape();
	await sleep(500);
	// Search All, through the real key handler: ⌘⇧F on a Mac, Ctrl+Shift+Alt+F elsewhere.
	const mac = process.platform === "darwin";
	await send("Input.dispatchKeyEvent", {
		type: "rawKeyDown",
		key: "f",
		code: "KeyF",
		windowsVirtualKeyCode: 70,
		modifiers: mac ? 4 + 8 : 1 + 2 + 8,
	});
	await send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: "f",
		code: "KeyF",
		windowsVirtualKeyCode: 70,
	});
	await sleep(700);
	await type('input[placeholder^="Search feeds"]', "release notes");
	await sleep(2600);
	await pressEscape();

	await caption("Odin. Make AI work for you.");
	await sleep(2600);
	await caption("");
	await sleep(400);
	const to = Date.now() / 1000;
	await send("Page.stopScreencast");

	console.log(`${frames.length} frames over ${(to - from).toFixed(1)}s`);
	const code = await encode(from, to);
	if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
	console.log("saved site/demo.webm");
	const mp4 = Bun.spawnSync(
		[
			process.env.FFMPEG_MP4 ?? "ffmpeg",
			"-loglevel",
			"error",
			"-y",
			"-i",
			join(OUT, "demo.webm"),
			"-c:v",
			"libx264",
			"-profile:v",
			"high",
			"-pix_fmt",
			"yuv420p",
			"-crf",
			"26",
			"-preset",
			"slow",
			"-movflags",
			"+faststart",
			"-an",
			join(OUT, "demo.mp4"),
		],
		{ stderr: "inherit" },
	);
	console.log(
		mp4.exitCode === 0
			? "saved site/demo.mp4"
			: "skip site/demo.mp4: no ffmpeg with libx264 (set FFMPEG_MP4)",
	);
	const poster = frames.findLast((f) => f.at <= posterAt) ?? frames[0];
	if (poster) writeFileSync(join(OUT, "demo.jpg"), poster.jpeg);
	console.log("saved site/demo.jpg");
	await quit(0);
} catch (error) {
	// What the window showed, to see where the script lost its way.
	const shown = await page<string>(`__text().slice(0, 1500)`).catch(() => "");
	const shot = await send("Page.captureScreenshot", { format: "png" }).catch(
		() => ({}) as CdpResult,
	);
	const failShot = join(tmpdir(), "odin-demo-fail.png");
	if (shot.data) writeFileSync(failShot, Buffer.from(shot.data, "base64"));
	console.error(
		`FAIL ${(error as Error).message} (window: ${failShot})\n${shown}\n`,
		appLog.slice(-2000),
	);
	await quit(1);
}
