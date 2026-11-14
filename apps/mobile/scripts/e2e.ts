/**
 * Walks the phone screens end to end in a headless Chrome at iPhone size,
 * through the real encrypted channel, and reports what a person would hit:
 * every screen's text and screenshot, each console error, uncaught exception
 * and spinner that never ends.
 *
 *   bun scripts/e2e-host.ts            (the remote host's real phone server), or
 *   bun scripts/fake-odin.ts           (sample sessions)
 *   bun run dev                        (the screens, on :5175)
 *   bun scripts/e2e.ts "<pair link>" ["<host pair link>"] <out dir>
 *
 * CHROME names the browser (default: Google Chrome on a Mac, else the
 * chrome-headless-shell Playwright keeps in ~/.cache/ms-playwright).
 * Exits 1 when a screen showed an error.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
// One link, or the Mac's and the remote host's together, as a paired phone holds them.
// A link, or where e2e-host.ts hands one out (http://localhost:4802).
const links = await Promise.all(
	args
		.filter((arg) => /^(odin|http):\/\//.test(arg))
		.map((arg) =>
			arg.startsWith("http") ? fetch(arg).then((r) => r.text()) : arg,
		),
);
const out = args.find((arg) => !/^(odin|http):\/\//.test(arg)) ?? "e2e-out";
if (!links.length) {
	console.error(
		'Usage: bun scripts/e2e.ts "<pair link>" ["<host pair link>"] [out dir]',
	);
	process.exit(2);
}
mkdirSync(out, { recursive: true });
const URL_ = Bun.env.E2E_URL ?? "http://localhost:5175/";
const PORT = 9333;

function findChrome(): string {
	if (Bun.env.CHROME) return Bun.env.CHROME;
	const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	if (existsSync(mac)) return mac;
	const cache = join(homedir(), ".cache", "ms-playwright");
	for (const dir of existsSync(cache)
		? readdirSync(cache).sort().reverse()
		: [])
		for (const sub of readdirSync(join(cache, dir))) {
			const bin = join(cache, dir, sub, "chrome-headless-shell");
			if (existsSync(bin)) return bin;
		}
	throw new Error("No Chrome found: set CHROME to one");
}

const chrome = spawn(
	findChrome(),
	[
		"--headless=new",
		`--remote-debugging-port=${PORT}`,
		`--user-data-dir=${mkdtempSync(join(tmpdir(), "odin-e2e-chrome-"))}`,
		"--no-first-run",
		"--no-sandbox",
		"--hide-scrollbars",
		"about:blank",
	],
	{ stdio: "ignore" },
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
for (let i = 0; i < 40 && !targets.length; i++) {
	await sleep(250);
	targets = await fetch(`http://localhost:${PORT}/json/list`)
		.then((r) => r.json())
		.catch(() => []);
}
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("Chrome didn't start");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));

/** What went wrong, by the screen it happened on. */
const problems: string[] = [];
let screen = "start";
const problem = (text: string) => {
	problems.push(`[${screen}] ${text}`);
	console.log(`  ! ${text}`);
};

let id = 0;
const pending = new Map<number, (v: unknown) => void>();
ws.addEventListener("message", (e) => {
	const msg = JSON.parse(String(e.data));
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)?.(msg.error ? { error: msg.error } : msg.result);
		pending.delete(msg.id);
	} else if (msg.method === "Runtime.exceptionThrown") {
		const d = msg.params.exceptionDetails;
		problem(`exception: ${d.exception?.description ?? d.text}`);
	} else if (
		msg.method === "Runtime.consoleAPICalled" &&
		msg.params.type === "error"
	) {
		problem(
			`console.error: ${msg.params.args
				.map((a: { value?: unknown; description?: string }) =>
					String(a.value ?? a.description ?? ""),
				)
				.join(" ")
				.slice(0, 600)}`,
		);
	}
});
type Answer = { data: string; result?: { value?: unknown } };
const send = (method: string, params = {}) =>
	new Promise<Answer>((r) => {
		pending.set(++id, r as (v: unknown) => void);
		ws.send(JSON.stringify({ id, method, params }));
	});
const run = async <T>(expression: string) =>
	(
		await send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		})
	)?.result?.value as T;

/** The screen's text, once it stops changing; says so when a spinner stays. */
async function settle(name: string, limitMs = 20_000): Promise<string> {
	screen = name;
	let text = "";
	let same = 0;
	const start = Date.now();
	while (Date.now() - start < limitMs) {
		await sleep(500);
		const now = await run<string>("document.body.innerText");
		// A session at work spins for as long as it works: that one isn't loading.
		const busy = await run<boolean>(
			`!!document.querySelector(".animate-spin") && !document.body.innerText.includes("Working")`,
		);
		// A session at work counts its seconds and tokens: numbers aside.
		const still = now.replace(/\d+/g, "") === text.replace(/\d+/g, "");
		same = still && !busy ? same + 1 : 0;
		text = now;
		if (same >= 3) break;
	}
	if (same < 3) problem(`still loading after ${limitMs / 1000}s`);
	const file = name.replace(/[^a-z0-9-]+/gi, "_");
	const { data } = await send("Page.captureScreenshot", { format: "png" });
	await Bun.write(`${out}/${file}.png`, Buffer.from(data, "base64"));
	await Bun.write(`${out}/${file}.txt`, text);
	// What the screens say when a call fails (ErrorLine, text-danger).
	// With the Mac away, what only the Mac does says so: that is the screen working.
	for (const line of await run<string[]>(
		`[...document.querySelectorAll(".text-danger")].map((e) => (e.textContent ?? "").trim()).filter(Boolean)`,
	))
		if (/only it can do this|needs Odin on your Mac/.test(line))
			console.log(`  (says it needs the Mac)`);
		else problem(`error on screen: ${line.slice(0, 300)}`);
	if (
		await run<boolean>("document.documentElement.scrollWidth > innerWidth + 1")
	)
		problem("the page scrolls sideways");
	console.log(`${name}: ${text.replace(/\s+/g, " ").slice(0, 140)}`);
	return text;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
	width: 440,
	height: 956,
	deviceScaleFactor: 2,
	mobile: true,
});
await send("Emulation.setTouchEmulationEnabled", {
	enabled: true,
	maxTouchPoints: 5,
});
await send("Emulation.setUserAgentOverride", {
	userAgent:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
});

await send("Page.navigate", { url: URL_ });
await sleep(1500);
for (const link of links) {
	const key = new URL(link).searchParams.has("h")
		? "odin-phone-host-pairing"
		: "odin-phone-pairing";
	await run(
		`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(link)})`,
	);
}
await send("Page.navigate", { url: URL_ });
await settle("board");

const panes = await run<string[]>(
	`[...new Set([...document.querySelectorAll('a[href^="#/s/"]')].map((a) => a.getAttribute("href")))]`,
);
console.log(`${panes.length} sessions on the board`);
for (const [i, href] of panes.entries()) {
	await run(`location.hash = ${JSON.stringify(href)}`);
	await settle(`session-${i + 1}`);
	const brief = await run<boolean>(
		`(() => { const b = document.querySelector('button[aria-label="Open the brief"]'); b?.click(); return !!b; })()`,
	);
	if (brief && i < 2) await settle(`session-${i + 1}-brief`, 90_000);
}
for (const hash of ["#/night", "#/ended", ""]) {
	await run(`location.hash = ${JSON.stringify(hash)}`);
	await settle(hash.slice(2) || "board-again");
}
if (
	await run<boolean>(
		`(() => { const b = document.querySelector('button[aria-label="New task"]'); b?.click(); return !!b; })()`,
	)
)
	await settle("new-task");
else problem("no New task button on the board");

/** Types into the first box that matches, as a keyboard would for React. */
const type = (selector: string, text: string) =>
	run<boolean>(`(() => {
	const box = document.querySelector(${JSON.stringify(selector)});
	if (!box) return false;
	const proto = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
	Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(box, ${JSON.stringify(text)});
	box.dispatchEvent(new Event("input", { bubbles: true }));
	return true;
})()`);
/** Taps the first button with that label or those words; false when there is none. */
const tap = (label: string) =>
	run<boolean>(`(() => {
	const b = [...document.querySelectorAll("button")].find((b) => !b.disabled && (b.getAttribute("aria-label") === ${JSON.stringify(label)} || b.innerText.trim() === ${JSON.stringify(label)}));
	b?.click();
	return !!b;
})()`);
const step = async (name: string, did: boolean, what: string) => {
	if (did) await settle(name);
	else {
		screen = name;
		problem(`nothing to tap or type in: ${what}`);
	}
};

// The taps that change something, on the board and on e2e-host.ts's practice
// session only (a real session is never typed into).
await run(`location.hash = ""`);
await settle("board-before-taps");
await step(
	"search",
	await type('input[type="search"], input[placeholder^="Search"]', "practice"),
	"the search box",
);
await tap("Clear the search");
await step("new-task-open", await tap("New task"), "New task");
await step(
	"new-task-typed",
	await type("textarea", "E2E walk: a task typed on the phone"),
	"the New task box",
);
await step("new-task-saved", await tap("Save"), "Save");
await run(`location.hash = ""`);
await settle("board-after-save");

const practice = await run<string | null>(
	`[...document.querySelectorAll('a[href^="#/s/"]')].find((a) => a.innerText.includes("E2E practice session"))?.getAttribute("href") ?? null`,
);
if (practice) {
	await run(`location.hash = ${JSON.stringify(practice)}`);
	await settle("practice");
	await step("practice-star", await tap("Star"), "Star");
	await step(
		"practice-typed",
		await type("textarea", "hello from the e2e walk"),
		"the reply box",
	);
	await step("practice-replied", await tap("Send"), "Send");
	await step("practice-done", await tap("Done"), "Done");
	await run(`location.hash = ""`);
	const after = await settle("board-after-done");
	if (after.includes("E2E practice session"))
		problem("the practice session is still on the board after Done");
} else
	console.log(
		"No practice session on this board: the taps on a session are skipped.",
	);

ws.close();
chrome.kill();
console.log(
	problems.length
		? `\n${problems.length} problems:\n${problems.join("\n")}`
		: "\nNo problems.",
);
process.exit(problems.length ? 1 : 0);
