// The App Store screenshots, from headless Chrome over the DevTools protocol:
// the phone screens at the 6.9-inch iPhone size (440x956 points at 3x), against
// fake-odin. screenshots.sh starts what it needs. Usage: bun screenshots.ts <out> <pair link>
const [out, link] = process.argv.slice(2);
const targets = await (await fetch("http://localhost:9333/json/list")).json();
const page = targets.find((t: { type: string }) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map<number, (v: unknown) => void>();
ws.addEventListener("message", (e) => {
	const msg = JSON.parse(String(e.data));
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)?.(msg.error ? { error: msg.error } : msg.result);
		pending.delete(msg.id);
	}
});
/** The parts of DevTools answers this script reads. */
type Answer = {
	data: string;
	identifier: string;
	result?: { value?: unknown };
};
const send = (method: string, params = {}) =>
	new Promise<Answer>((r) => {
		pending.set(++id, r as (v: unknown) => void);
		ws.send(JSON.stringify({ id, method, params }));
	});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = async (expression: string) =>
	(
		await send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		})
	)?.result?.value;
const shot = async (name: string, wait = 2500) => {
	await sleep(wait);
	const { data } = await send("Page.captureScreenshot", { format: "png" });
	await Bun.write(`${out}/${name}.png`, Buffer.from(data, "base64"));
	console.log("saved", name);
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
	width: 440,
	height: 956,
	deviceScaleFactor: 3,
	mobile: true,
});
// Room for the status bar and the home indicator, as on the phone.
await send("Emulation.setSafeAreaInsetsOverride", {
	insets: {
		top: 62,
		topMax: 62,
		bottom: 34,
		bottomMax: 34,
		left: 0,
		leftMax: 0,
		right: 0,
		rightMax: 0,
	},
});
await send("Emulation.setTouchEmulationEnabled", {
	enabled: true,
	maxTouchPoints: 5,
});
await send("Emulation.setUserAgentOverride", {
	userAgent:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
});

// The Pair screen shows only inside the native app: a stub Capacitor for that one shot.
const stub = await send("Page.addScriptToEvaluateOnNewDocument", {
	source: `if (!localStorage.getItem("odin-phone-pairing")) window.Capacitor = { Plugins: { App: { addListener() { return { remove() {} }; }, getLaunchUrl: async () => ({}) } } };`,
});
await send("Page.navigate", { url: "http://localhost:5175/" });
await shot("05-pair", 4000);
await send("Page.removeScriptToEvaluateOnNewDocument", {
	identifier: stub.identifier,
});

await run(
	`localStorage.setItem("odin-phone-pairing", ${JSON.stringify(link)}); "ok"`,
);
await send("Page.navigate", { url: "http://localhost:5175/" });
await shot("01-board", 8000);

await run(`location.hash = "#/s/p1"; "ok"`);
await shot("02-session", 5000);

console.log(
	"brief",
	await run(`(async () => {
	const open = document.querySelector('button[aria-label="Open the brief"]');
	if (!open) return "no Brief button";
	open.click();
	return "opened";
})()`),
);
await shot("03-brief", 4000);

console.log(
	"task",
	await run(`(async () => {
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
	const repo = [...document.querySelectorAll("select")].find((s) => s.getAttribute("aria-label") !== "Profile");
	pick.set.call(repo, [...repo.options].find((o) => o.value).value);
	repo.dispatchEvent(new Event("change", { bubbles: true }));
	return "typed";
})()`),
);
await shot("04-new-task", 1500);
ws.close();
process.exit(0);
