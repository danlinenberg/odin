/**
 * Are the agents already eating enough of this Mac that starting another one
 * would hurt?
 *
 * Reads the snapshot `resourceMetrics.getSnapshot` already collects — pidusage
 * over every live session's process tree — so nothing new is probed.
 */

/** The fields of a ResourceMetricsSnapshot this needs. */
export interface MachineLoadInput {
	host: {
		cpuCoreCount: number;
		loadAverage1m: number;
		memoryUsagePercent: number;
		totalMemory: number;
	};
	/** App + every agent session, summed, where 100 = one core saturated. */
	totalCpu: number;
	/** App + every agent session's RSS, summed, in bytes. */
	totalMemory: number;
	workspaces: { sessions: unknown[] }[];
}

/**
 * Share of the whole machine Odin's agents may burn before the next launch
 * waits.
 *
 * ponytail: one fixed number, tuned on a 12-core Mac that idles at ~10% with a
 * dozen sessions parked. It's the knob — move it to ~/.config/odin.json if a
 * different machine argues with it.
 */
export const BUSY_AGENT_CPU_PERCENT = 70;

/**
 * Share of this Mac's RAM Odin's agents may hold before it stops promising
 * room for another one.
 *
 * ponytail: same kind of knob as BUSY_AGENT_CPU_PERCENT, and unlike
 * `memoryPercent` it's measured per-process, so it means what it says.
 */
export const AGENT_MEMORY_BUDGET_PERCENT = 70;

/**
 * What one session is assumed to cost, in GB.
 *
 * ponytail: a fixed figure, not the running average of what the live sessions
 * hold. A parked session sits near 0.2 GB and a working one near 2, so the
 * average swings 10x and took `roomForMore` with it — 8 one moment, 40 the
 * next. Budget for a session that's actually working; move the knob if a
 * different machine argues with it.
 */
export const SESSION_MEMORY_GB = 2;

export interface MachineLoad {
	/**
	 * Share of the machine Odin's own agents are burning, 0–100+. The only
	 * number that decides anything: it's measured per-process, so it can't
	 * blame Claude for someone else's build.
	 */
	agentCpuPercent: number;
	/**
	 * Resident memory Odin's own processes hold, in GB. Per-process like
	 * `agentCpuPercent`, so unlike `memoryPercent` it's a number you can act
	 * on — it can't blame Claude for the rest of the Mac.
	 */
	agentMemoryGb: number;
	/**
	 * Whole machine, 0–100+: 1-minute load average over the core count. Shown,
	 * never acted on — macOS counts threads blocked in I/O, so a healthy Mac
	 * running a few agents sits near 100% all day.
	 */
	cpuPercent: number;
	/**
	 * Shown, never acted on. macOS hands `os.freemem()` only the truly-free
	 * pages — cached and compressed ones count as used — so a healthy Mac sits
	 * at 95–99% all day. Gating on it would park every launch forever.
	 */
	memoryPercent: number;
	agentCount: number;
	/**
	 * Sessions that still fit under AGENT_MEMORY_BUDGET_PERCENT, at
	 * SESSION_MEMORY_GB each.
	 */
	roomForMore: number;
	busy: boolean;
	/** Why it's busy, phrased for a toast. Null when it isn't. */
	reason: string | null;
}

function percent(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export function machineLoad(snapshot: MachineLoadInput): MachineLoad {
	const cores = Math.max(1, snapshot.host.cpuCoreCount);
	const agentCpuPercent = percent(snapshot.totalCpu / cores);
	const agentCount = snapshot.workspaces.reduce(
		(total, workspace) => total + workspace.sessions.length,
		0,
	);
	const busy = agentCpuPercent >= BUSY_AGENT_CPU_PERCENT;
	const memoryGb = snapshot.totalMemory / 1024 ** 3;
	const agentMemoryGb = Number.isFinite(memoryGb)
		? Math.max(0, Math.round(memoryGb * 10) / 10)
		: 0;

	const budgetGb =
		(snapshot.host.totalMemory / 1024 ** 3) *
		(AGENT_MEMORY_BUDGET_PERCENT / 100);
	const spareGb = Number.isFinite(budgetGb) ? budgetGb - agentMemoryGb : 0;
	const roomForMore = Math.max(0, Math.floor(spareGb / SESSION_MEMORY_GB));

	return {
		agentCpuPercent,
		agentMemoryGb,
		roomForMore,
		cpuPercent: percent((snapshot.host.loadAverage1m / cores) * 100),
		memoryPercent: percent(snapshot.host.memoryUsagePercent),
		agentCount,
		busy,
		reason: busy
			? `${agentCount} agent${agentCount === 1 ? "" : "s"} using ${agentCpuPercent}% of this Mac`
			: null,
	};
}
