import { readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, homedir, totalmem } from "node:os";
import type { MachineLoadInput } from "shared/machine-load";

/**
 * This server's load, in the shape the launch gate reads (shared/machine-load),
 * so a remote server holds launches back on its own CPU, memory and disk - not
 * the laptop's.
 */

let lastTimes: { idle: number; total: number } | null = null;
let cpuPercent = 0;

function cpuTimes(): { idle: number; total: number } {
	let idle = 0;
	let total = 0;
	for (const cpu of cpus()) {
		const t = cpu.times;
		idle += t.idle;
		total += t.user + t.nice + t.sys + t.idle + t.irq;
	}
	return { idle, total };
}

/** Take a CPU reading: the busy share since the previous one. */
export function sampleCpu(): void {
	const now = cpuTimes();
	const prev = lastTimes;
	lastTimes = now;
	if (!prev) return;
	const total = now.total - prev.total;
	if (total > 0) cpuPercent = 100 * (1 - (now.idle - prev.idle) / total);
}

/** What the kernel could hand a new process: MemAvailable, else free memory. */
function availableMemory(): number {
	try {
		const kb = /^MemAvailable:\s+(\d+) kB/m.exec(
			readFileSync("/proc/meminfo", "utf8"),
		)?.[1];
		if (kb) return Number(kb) * 1024;
	} catch {
		// Not Linux - fall through.
	}
	return freemem();
}

function diskFreePercent(): number | undefined {
	try {
		const stats = statfsSync(homedir());
		return stats.blocks > 0 ? (100 * stats.bavail) / stats.blocks : undefined;
	} catch {
		return undefined;
	}
}

export function machineSnapshot(liveSessions: unknown[]): MachineLoadInput {
	return {
		host: {
			cpuCoreCount: cpus().length,
			cpuUsagePercent: cpuPercent,
			memoryUsagePercent: 100 * (1 - availableMemory() / totalmem()),
			totalMemory: totalmem(),
			availableMemory: availableMemory(),
			diskFreePercent: diskFreePercent(),
		},
		totalCpu: 0,
		totalMemory: 0,
		workspaces: [{ sessions: liveSessions }],
	};
}
