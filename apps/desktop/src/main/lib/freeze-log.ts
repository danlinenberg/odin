import {
	appendFile,
	mkdir,
	readdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { Session } from "node:inspector";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { ODIN_HOME_DIR } from "./app-environment";

/**
 * When Odin freezes, ~/.odin/freeze.log says which process stalled and, for
 * the window, which scripts held it (the renderer reports long animation
 * frames as `[freeze]` console lines - see renderer/lib/freeze-reporter.ts).
 * Nothing else records a stall in a release build, so a "clicks do nothing
 * for a few seconds" report had no trace to read.
 *
 * For main, a stall line alone can't say what held it. So the first stall
 * starts a sampling CPU profile, and each later stall in it names the
 * functions that ran during it, with the profile kept in
 * ~/.odin/freeze-profiles/ (open it in Chrome DevTools' Performance tab).
 * The profiler stops after PROFILE_IDLE_MS without a stall.
 */
const LOG_PATH = join(ODIN_HOME_DIR, "freeze.log");
const PROFILE_DIR = join(ODIN_HOME_DIR, "freeze-profiles");
const SESSION_MATCH_LOG = join(ODIN_HOME_DIR, "session-match.log");
const TICK_MS = 250;
const STALL_MS = 1_000;
/** Each profile covers this long; one with a stall in it is kept. */
const PROFILE_WINDOW_MS = 60_000;
const PROFILE_IDLE_MS = 10 * 60_000;
const PROFILES_KEPT = 5;
/** Microseconds between samples: cheap, and a 1s stall still gets ~100. */
const SAMPLE_US = 10_000;

function write(line: string): void {
	void appendFile(LOG_PATH, `${new Date().toISOString()} ${line}\n`).catch(
		() => {},
	);
}

export interface CpuProfile {
	nodes: {
		id: number;
		callFrame: {
			functionName: string;
			url: string;
			lineNumber: number;
			columnNumber?: number;
		};
		children?: number[];
	}[];
	startTime: number;
	endTime: number;
	samples?: number[];
	timeDeltas?: number[];
}

/**
 * The functions that held the samples between `fromUs` and `toUs` (the
 * profile's clock, microseconds), most first, as "<ms>ms <fn> <file>:<line>"
 * followed by up to two callers ("< caller file:line").
 * "(program)" or "(idle)" on top means native code or the OS held main
 * (a sync syscall, page faults), not JavaScript.
 */
export function describeStall(
	profile: CpuProfile,
	fromUs: number,
	toUs: number,
	top = 3,
): string[] {
	const byId = new Map(profile.nodes.map((node) => [node.id, node]));
	const parentOf = new Map<number, number>();
	for (const node of profile.nodes)
		for (const child of node.children ?? []) parentOf.set(child, node.id);
	const name = (id: number) => {
		const frame = byId.get(id)?.callFrame;
		if (!frame) return "?";
		const file = frame.url ? frame.url.split("/").pop() : "";
		return `${frame.functionName || "anonymous"}${file ? ` ${file}:${frame.lineNumber + 1}` : ""}`;
	};
	const stackOf = (id: number) => {
		const names = [name(id)];
		for (
			let up = parentOf.get(id);
			up !== undefined && names.length < 3;
			up = parentOf.get(up)
		) {
			const caller = name(up);
			if (caller !== "(root)") names.push(caller);
		}
		return names.join(" < ");
	};
	const samples = profile.samples ?? [];
	const deltas = profile.timeDeltas ?? [];
	const spent = new Map<string, number>();
	let at = profile.startTime;
	for (let i = 0; i < samples.length; i++) {
		at += deltas[i] ?? 0;
		const next = at + (deltas[i + 1] ?? 0);
		if (next <= fromUs || at >= toUs) continue;
		const id = samples[i];
		if (id === undefined || !byId.has(id)) continue;
		const key = stackOf(id);
		spent.set(
			key,
			(spent.get(key) ?? 0) + Math.min(next, toUs) - Math.max(at, fromUs),
		);
	}
	return [...spent]
		.sort((a, b) => b[1] - a[1])
		.slice(0, top)
		.map(([key, us]) => `${Math.round(us / 1000)}ms ${key}`);
}

function post<T>(session: Session, method: string, params?: object) {
	return new Promise<T>((resolve, reject) =>
		session.post(method, params ?? {}, (error, result) =>
			error ? reject(error) : resolve(result as T),
		),
	);
}

async function keepProfile(profile: CpuProfile): Promise<void> {
	await mkdir(PROFILE_DIR, { recursive: true });
	const name = `main-${new Date().toISOString().replace(/[:.]/g, "-")}.cpuprofile`;
	await writeFile(join(PROFILE_DIR, name), JSON.stringify(profile));
	const old = (await readdir(PROFILE_DIR))
		.filter((file) => file.startsWith("main-"))
		.sort()
		.slice(0, -PROFILES_KEPT);
	for (const file of old) await unlink(join(PROFILE_DIR, file)).catch(() => {});
}

/** Samples main after a stall, so the next ones say what held it. */
function createStallProfiler() {
	let session: Session | null = null;
	let lastStallAt = 0;
	/** Stalls since the profile started, in performance.now() ms. */
	let stalls: { from: number; to: number }[] = [];

	const start = async (s: Session) => {
		stalls = [];
		await post(s, "Profiler.start");
	};

	const cycle = async () => {
		const s = session;
		if (!s) return;
		const { profile } = await post<{ profile: CpuProfile }>(s, "Profiler.stop");
		// The profile's clock (µs) against performance.now() (ms), at the stop.
		const offsetUs = profile.endTime - performance.now() * 1000;
		const seen = stalls;
		if (performance.now() - lastStallAt > PROFILE_IDLE_MS) {
			s.disconnect();
			session = null;
		} else await start(s);
		if (seen.length === 0) return;
		for (const { from, to } of seen) {
			const top = describeStall(
				profile,
				from * 1000 + offsetUs,
				to * 1000 + offsetUs,
			);
			write(
				`main stall ${Math.round(to - from)}ms ran: ${top.join(" | ") || "nothing sampled"}`,
			);
		}
		await keepProfile(profile);
	};

	return {
		async stalled(from: number, to: number) {
			lastStallAt = to;
			if (session) {
				stalls.push({ from, to });
				return;
			}
			const s = new Session();
			s.connect();
			session = s;
			await post(s, "Profiler.enable");
			await post(s, "Profiler.setSamplingInterval", { interval: SAMPLE_US });
			await start(s);
			const timer = setInterval(() => {
				if (!session) return clearInterval(timer);
				cycle().catch(() => {});
			}, PROFILE_WINDOW_MS);
			timer.unref();
		},
	};
}

/** Main's event loop: a tick that lands late by a second was blocked. */
export function startMainStallLog(): void {
	const profiler = createStallProfiler();
	let last = performance.now();
	setInterval(() => {
		const now = performance.now();
		const late = now - last - TICK_MS;
		last = now;
		if (late < STALL_MS) return;
		write(`main blocked ${Math.round(late)}ms`);
		profiler.stalled(now - late, now).catch(() => {});
	}, TICK_MS).unref();
}

export function attachWindowFreezeLog(window: BrowserWindow): void {
	let since = 0;
	window.on("unresponsive", () => {
		since = Date.now();
		write("window unresponsive");
	});
	window.on("responsive", () => {
		if (since) write(`window responsive after ${Date.now() - since}ms`);
		since = 0;
	});
	window.webContents.on("console-message", (_event, _level, message) => {
		if (message.startsWith("[freeze] ")) write(`window ${message.slice(9)}`);
		// Open on board's row-to-session matches (renderer all/use-start-item.ts).
		if (message.startsWith("[session-match] "))
			void appendFile(
				SESSION_MATCH_LOG,
				`${new Date().toISOString()} ${message.slice(16)}\n`,
			).catch(() => {});
	});
}
