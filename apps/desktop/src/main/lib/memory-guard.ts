import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Notification } from "electron";
import { ODIN_HOME_DIR } from "./app-environment";
import {
	captureProcessSnapshot,
	enrichWithPhysFootprint,
	getSubtreePids,
	type ProcessSnapshot,
} from "./resource-metrics/process-tree";

/**
 * Odin's process tree (main, renderer, GPU, and every agent session in the
 * terminal-host daemon) once grew to 137 GB and took the Mac down with it.
 * Once a minute, name anything past WARN in ~/.odin/memory-guard.log, and
 * SIGKILL anything past KILL before it gets there. Main and the daemon are
 * spared — killing either takes every session with it. The GPU process is
 * not: Chromium relaunches it.
 */
const EVERY_MS = 60_000;
const GB = 1024 ** 3;
export const WARN_BYTES = 4 * GB;
export const KILL_BYTES = 16 * GB;
const LOG_PATH = join(ODIN_HOME_DIR, "memory-guard.log");
const DAEMON_PID_PATH = join(ODIN_HOME_DIR, "terminal-host.pid");

export function findOffenders(
	snapshot: ProcessSnapshot,
	pids: number[],
	spared: Set<number>,
): { pid: number; memory: number; kill: boolean }[] {
	return pids
		.map((pid) => ({ pid, memory: snapshot.byPid.get(pid)?.memory ?? 0 }))
		.filter((p) => p.memory > WARN_BYTES)
		.map((p) => ({ ...p, kill: p.memory > KILL_BYTES && !spared.has(p.pid) }));
}

function commandName(pid: number): Promise<string> {
	return new Promise((resolve) =>
		execFile("ps", ["-o", "comm=", "-p", String(pid)], (_e, out) =>
			resolve(out?.trim().split("/").pop() || "?"),
		),
	);
}

async function check(): Promise<void> {
	const daemonPid = Number(
		(await readFile(DAEMON_PID_PATH, "utf8").catch(() => "")).trim(),
	);
	const roots = [process.pid, ...(daemonPid > 0 ? [daemonPid] : [])];
	const snapshot = await captureProcessSnapshot();
	const pids = roots.flatMap((root) => getSubtreePids(snapshot, root));
	enrichWithPhysFootprint(snapshot, pids);

	for (const { pid, memory, kill } of findOffenders(
		snapshot,
		pids,
		new Set(roots),
	)) {
		const name = await commandName(pid);
		const gb = (memory / GB).toFixed(1);
		const line = `${new Date().toISOString()} pid=${pid} ${name} ${gb}GB${kill ? " KILLED" : ""}`;
		console.warn(`[main] memory-guard: ${line}`);
		await appendFile(LOG_PATH, `${line}\n`).catch(() => {});
		if (!kill) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
		new Notification({
			title: "Odin killed a runaway process",
			body: `${name} (pid ${pid}) was using ${gb} GB.`,
		}).show();
	}
}

export function startMemoryGuard(): void {
	setInterval(() => {
		check().catch((error) =>
			console.warn("[main] memory-guard check failed:", error),
		);
	}, EVERY_MS).unref();
}
