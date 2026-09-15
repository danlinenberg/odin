/**
 * Are the agents already eating enough of this Mac that starting another one
 * would hurt?
 *
 * Reads the snapshot `resourceMetrics.getSnapshot` already collects — pidusage
 * over every live session's process tree — so nothing new is probed.
 */

/** The fields of a ResourceMetricsSnapshot this needs. */
export interface MachineLoadInput {
	/** Odin itself (main + renderer + helpers), so sessions can be costed alone. */
	app: { memory: number };
	host: {
		cpuCoreCount: number;
		loadAverage1m: number;
		memoryUsagePercent: number;
		/** This Mac's installed RAM, in bytes. */
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
 * Share of this Mac's installed RAM the sessions may hold before the next one
 * is a bad idea. A share of *total*, not of free: `os.freemem()` counts cached
 * and compressed pages as used, so free memory is 1–5% on a healthy Mac and
 * would say "no room" forever.
 *
 * ponytail: one fixed fraction, leaving the rest for the app, the OS and
 * whatever else you're running. Same knob as above — move both to
 * ~/.config/odin.json if a machine argues with them.
 */
export const AGENT_MEMORY_BUDGET_PERCENT = 60;

/**
 * The least a session is ever costed at, however little it holds right now.
 *
 * A pane measured seconds after launch is a few hundred MB — dividing the
 * budget by *that* promises room for dozens of agents no Mac can actually run,
 * because every one of them grows to a GB or two once it starts working.
 *
 * ponytail: a Claude Code pane (node + agent + pty) doing real work. It's the
 * floor and the zero-session estimate both — move it to ~/.config/odin.json if
 * a machine argues with it.
 */
const ASSUMED_SESSION_GB = 1.5;

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
	 * How many more sessions fit: the memory budget left, divided by what a
	 * session actually costs on this machine right now. Zero while `busy`,
	 * because a launch would wait anyway.
	 */
	roomForMore: number;
	/** GB one session is costed at: the live average, floored at the assumed. */
	sessionMemoryGb: number;
	busy: boolean;
	/** Why it's busy, phrased for a toast. Null when it isn't. */
	reason: string | null;
}

function percent(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function gb(bytes: number): number {
	const value = bytes / 1024 ** 3;
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function machineLoad(snapshot: MachineLoadInput): MachineLoad {
	const cores = Math.max(1, snapshot.host.cpuCoreCount);
	const agentCpuPercent = percent(snapshot.totalCpu / cores);
	const agentCount = snapshot.workspaces.reduce(
		(total, workspace) => total + workspace.sessions.length,
		0,
	);
	const busy = agentCpuPercent >= BUSY_AGENT_CPU_PERCENT;
	const memoryGb = gb(snapshot.totalMemory);

	// The sessions' own RSS: `totalMemory` includes Odin itself, which doesn't
	// get any bigger when you open another pane.
	const sessionsGb = Math.max(0, memoryGb - gb(snapshot.app.memory));
	// Never below the floor: young sessions under-report, and the badge is a
	// promise about sessions that will be working, not idling.
	const perSessionGb =
		agentCount > 0
			? Math.max(sessionsGb / agentCount, ASSUMED_SESSION_GB)
			: ASSUMED_SESSION_GB;
	const budgetGb =
		(gb(snapshot.host.totalMemory) * AGENT_MEMORY_BUDGET_PERCENT) / 100;
	const roomForMore = busy
		? 0
		: Math.max(0, Math.floor((budgetGb - sessionsGb) / perSessionGb));

	return {
		agentCpuPercent,
		agentMemoryGb: Math.round(memoryGb * 10) / 10,
		roomForMore,
		sessionMemoryGb: Math.round(perSessionGb * 10) / 10,
		cpuPercent: percent((snapshot.host.loadAverage1m / cores) * 100),
		memoryPercent: percent(snapshot.host.memoryUsagePercent),
		agentCount,
		busy,
		reason: busy
			? `${agentCount} agent${agentCount === 1 ? "" : "s"} using ${agentCpuPercent}% of this Mac`
			: null,
	};
}
