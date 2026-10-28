/**
 * Records a CPU profile of the running dev renderer and prints where the time
 * went, so "Odin Dev feels slow" turns into a list of functions and modules.
 *
 *   bun run apps/desktop/scripts/cdp-cpu-profile.ts [seconds]
 *
 * Use the app the way that feels slow while it records (default 20s). It
 * attaches over the CDP port odin-dev.sh opens (19223) to the page on the vite
 * port odin-dev.sh last used (~/.odin/dev-vite-port); RENDERER_REMOTE_DEBUG_PORT
 * and DESKTOP_VITE_PORT override them. The full profile is saved under
 * ~/.odin/profiles - DevTools' Performance panel opens it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.ODIN_HOME_DIR ?? join(homedir(), ".odin");
const PORT = process.env.RENDERER_REMOTE_DEBUG_PORT ?? "19223";
const VITE_PORT =
	process.env.DESKTOP_VITE_PORT ??
	(() => {
		try {
			return readFileSync(join(home, "dev-vite-port"), "utf8").trim();
		} catch {
			return "5173";
		}
	})();
const seconds = Number(process.argv[2] ?? 20);

interface CdpTarget {
	type: string;
	url: string;
	webSocketDebuggerUrl?: string;
}

interface ProfileNode {
	id: number;
	callFrame: { functionName: string; url: string };
}

interface Profile {
	nodes: ProfileNode[];
	samples: number[];
	timeDeltas: number[];
}

const targets = (await fetch(`http://127.0.0.1:${PORT}/json`).then((r) =>
	r.json(),
)) as CdpTarget[];
const page = targets.find(
	(t) =>
		t.type === "page" &&
		t.webSocketDebuggerUrl &&
		t.url.includes(`localhost:${VITE_PORT}`),
);
if (!page?.webSocketDebuggerUrl) {
	console.error(
		`No renderer target on :${PORT} for vite port ${VITE_PORT}. Targets: ${targets
			.map((t) => `${t.type} ${t.url}`)
			.join(", ")}`,
	);
	process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve));
let nextId = 0;
const pending = new Map<number, (result: unknown) => void>();
ws.addEventListener("message", (event) => {
	const msg = JSON.parse(event.data as string);
	pending.get(msg.id)?.(msg.result);
	pending.delete(msg.id);
});
const send = <T>(method: string, params: object = {}) =>
	new Promise<T>((resolve) => {
		const id = ++nextId;
		pending.set(id, resolve as (result: unknown) => void);
		ws.send(JSON.stringify({ id, method, params }));
	});

type Metrics = { metrics: { name: string; value: number }[] };
const metricMap = (m: Metrics) =>
	Object.fromEntries(m.metrics.map((x) => [x.name, x.value]));

await send("Performance.enable");
const before = metricMap(await send<Metrics>("Performance.getMetrics"));
await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval: 500 });
await send("Profiler.start");
console.error(`recording ${seconds}s of ${page.url} - use the app now`);
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const { profile } = await send<{ profile: Profile }>("Profiler.stop");
const after = metricMap(await send<Metrics>("Performance.getMetrics"));
ws.close();

const dir = join(home, "profiles");
mkdirSync(dir, { recursive: true });
const file = join(
	dir,
	`cpu-${new Date().toISOString().replace(/[:.]/g, "-")}.cpuprofile`,
);
writeFileSync(file, JSON.stringify(profile));

// Where a frame's code lives: a prebundled dep, a workspace package, a renderer
// source file, or one of V8's own buckets (idle, GC, program).
function bucket(url: string, fn: string): string {
	if (!url) return fn || "(anonymous)";
	const path = new URL(url, "http://x").pathname;
	const dep = path.match(/\/\.vite\/deps\/([^/?]+)/);
	if (dep) return `dep ${dep[1]}`;
	const nm = path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/g);
	if (nm) return `dep ${nm[nm.length - 1].replace("node_modules/", "")}`;
	const pkg = path.match(/\/packages\/([^/]+)\//);
	if (pkg) return `packages/${pkg[1]}`;
	return path.replace(/^\/@fs\/.*\/apps\/desktop\/src\/renderer/, "");
}

const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const selfUs = new Map<number, number>();
for (let i = 0; i < profile.samples.length; i++) {
	const id = profile.samples[i];
	selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
}
const byBucket = new Map<string, number>();
const byFn = new Map<string, number>();
let total = 0;
for (const [id, us] of selfUs) {
	const { functionName, url } = nodes.get(id)?.callFrame ?? {
		functionName: "",
		url: "",
	};
	total += us;
	const b = bucket(url, functionName);
	byBucket.set(b, (byBucket.get(b) ?? 0) + us);
	const f = `${functionName || "(anonymous)"}  [${b}]`;
	byFn.set(f, (byFn.get(f) ?? 0) + us);
}
const idle = byBucket.get("(idle)") ?? 0;
const busy = total - idle;
const ms = (us: number) => `${(us / 1000).toFixed(0).padStart(6)}ms`;
const pct = (us: number) => `${((us / busy) * 100).toFixed(1).padStart(5)}%`;
const top = (m: Map<string, number>, n: number) =>
	[...m]
		.filter(([k]) => !k.startsWith("(idle)"))
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(([k, us]) => `${ms(us)} ${pct(us)}  ${k}`)
		.join("\n");
const delta = (name: string) =>
	((after[name] ?? 0) - (before[name] ?? 0)).toFixed(2);

console.log(
	[
		`renderer busy ${ms(busy).trim()} of ${seconds}s (${((busy / total) * 100).toFixed(0)}%)`,
		`task ${delta("TaskDuration")}s  script ${delta("ScriptDuration")}s  layout ${delta("LayoutDuration")}s  style ${delta("RecalcStyleDuration")}s`,
		`DOM nodes ${after.Nodes}  listeners ${after.JSEventListeners}  JS heap ${((after.JSHeapUsedSize ?? 0) / 1e6).toFixed(0)}MB`,
		"",
		"by module (self time, % of busy):",
		top(byBucket, 20),
		"",
		"by function:",
		top(byFn, 30),
		"",
		`profile: ${file}`,
	].join("\n"),
);
process.exit(0);
