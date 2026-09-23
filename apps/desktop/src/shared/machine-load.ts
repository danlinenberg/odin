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
		memoryUsagePercent: number;
		/**
		 * The whole machine's CPU, 0-100 — system+user, i.e. 100 minus idle.
		 * Zero on a snapshot collected before this existed, and on the first
		 * one after launch (it's a delta between two readings).
		 */
		cpuUsagePercent?: number;
		/** This Mac's installed RAM, in bytes. */
		totalMemory: number;
		/**
		 * What the OS could hand a new process right now — free plus reclaimable
		 * pages, in bytes. Zero on a snapshot collected before this existed.
		 */
		availableMemory: number;
	};
	/** App + every agent session, summed, where 100 = one core saturated. */
	totalCpu: number;
	/** App + every agent session's RSS, summed, in bytes. */
	totalMemory: number;
	workspaces: { sessions: unknown[] }[];
}

/**
 * How much of the whole machine can be busy — anyone's work, Odin's agents
 * included — before the next launch waits.
 *
 * One number, not two: the agents' CPU is part of the Mac's, so a separate
 * agent limit could only ever trip while the Mac still had room.
 *
 * ponytail: the default — Settings → Board overrides it. 85 let launches land
 * on a Mac that was already suffocating; 50 held them on one that was fine.
 */
export const BUSY_HOST_CPU_PERCENT = 70;

/**
 * Free memory (free + reclaimable) below which the next launch waits.
 *
 * CPU alone misses a Mac that's out of memory: it swaps, and crawls while the
 * CPU looks idle. ponytail: the default — Settings → Board overrides it. 2 GB
 * is one session mid-build.
 */
export const MIN_FREE_MEMORY_GB = 2;

/** What a launch waits on, as Settings → Board has it. */
export interface LaunchLimits {
	hostCpuPercent: number;
	minFreeMemoryGb: number;
}

export const DEFAULT_LAUNCH_LIMITS: LaunchLimits = {
	hostCpuPercent: BUSY_HOST_CPU_PERCENT,
	minFreeMemoryGb: MIN_FREE_MEMORY_GB,
};

export interface MachineLoad {
	/**
	 * Share of the machine Odin's own agents are burning, 0–100+. Shown, not
	 * acted on — it's already inside `cpuPercent`. Measured per-process, so it
	 * can't blame Claude for someone else's build.
	 */
	agentCpuPercent: number;
	/**
	 * Resident memory Odin's own processes hold, in GB. Per-process like
	 * `agentCpuPercent`, so it's a number you can act
	 * on — it can't blame Claude for the rest of the Mac.
	 */
	agentMemoryGb: number;
	/**
	 * Whole machine, 0–100: system+user, i.e. 100 minus idle. Acted on — a Mac
	 * pinned here is choking whoever owns the work, so launching into it is
	 * how you make it worse.
	 *
	 * Not the load average: macOS counts threads blocked in I/O there, so it
	 * sits near the core count on a Mac doing nothing.
	 */
	cpuPercent: number;
	agentCount: number;
	/**
	 * What this Mac could still hand out, in GB: free plus reclaimable pages.
	 *
	 * Acted on below `LaunchLimits.minFreeMemoryGb`. Measured, not predicted. "How many more sessions fit" used to live here
	 * and was deleted twice over: a count needs a per-session cost, and the
	 * honest one swings from 0.2 GB parked to 2 GB mid-build, so every constant
	 * we picked made the badge confidently wrong — "room for 31" on a Mac with
	 * 4 GB free, then "room for 2" on the Mac already running nine. Free memory
	 * and what the agents hold are both facts; you can read them.
	 */
	availableMemoryGb: number;
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

export function machineLoad(
	snapshot: MachineLoadInput,
	limits: LaunchLimits = DEFAULT_LAUNCH_LIMITS,
): MachineLoad {
	const cores = Math.max(1, snapshot.host.cpuCoreCount);
	const agentCpuPercent = percent(snapshot.totalCpu / cores);
	const agentCount = snapshot.workspaces.reduce(
		(total, workspace) => total + workspace.sessions.length,
		0,
	);
	const hostCpuPercent = percent(snapshot.host.cpuUsagePercent ?? 0);
	// The whole Mac counts, not only our slice of it: a build, a Docker daemon
	// or someone else's agent runner leaves the same missing headroom, and a
	// new session lands in it just as hard.
	const cpuBusy = hostCpuPercent >= limits.hostCpuPercent;
	const availableMemoryGb =
		Math.round(gb(snapshot.host.availableMemory) * 10) / 10;
	// Zero means "not measured" (a snapshot from before the field existed), not
	// "out of memory" — gating on it would park every launch.
	const memoryBusy =
		snapshot.host.availableMemory > 0 &&
		availableMemoryGb < limits.minFreeMemoryGb;
	const busy = cpuBusy || memoryBusy;
	const memoryGb = gb(snapshot.totalMemory);

	const reason = cpuBusy
		? `this Mac is at ${hostCpuPercent}% CPU`
		: memoryBusy
			? `this Mac has only ${availableMemoryGb} GB free`
			: null;

	return {
		agentCpuPercent,
		agentMemoryGb: Math.round(memoryGb * 10) / 10,
		availableMemoryGb,
		cpuPercent: hostCpuPercent,
		agentCount,
		busy,
		reason,
	};
}

/**
 * Enough of this Mac for one session's badge to turn loud.
 *
 * ponytail: two fixed numbers, same knob as BUSY_HOST_CPU_PERCENT. 2 GB is
 * roughly double what a parked session holds; 80% is most of one core held
 * down. Move them if a bigger Mac argues.
 */
export const HEAVY_MEMORY_GB = 2;
export const HEAVY_CPU_PERCENT = 80;

/** One session's slice of a ResourceMetricsSnapshot. */
export interface SessionUsage {
	/** Its process tree, where 100 = one core saturated. */
	cpu: number;
	/** Its process tree's resident memory, in bytes. */
	memory: number;
}

/**
 * What a session's badge says, and whether it's heavy enough to be loud.
 *
 * Every card gets one: a board that "already feels slow" with nothing marked
 * can't tell you where the memory went. Memory is always named — it's what the
 * header chip counts, so the badges add up to it — and CPU only when it's the
 * thing that's high. `heavy` only picks the colour.
 */
export function sessionUsageLabel(usage: SessionUsage): {
	label: string;
	heavy: boolean;
} {
	const memoryGb = gb(usage.memory);
	const cpuPercent = percent(usage.cpu);
	const heavyCpu = cpuPercent >= HEAVY_CPU_PERCENT;
	const label = `${Math.round(memoryGb * 10) / 10} GB`;
	return {
		label: heavyCpu ? `${label} · ${cpuPercent}% CPU` : label,
		heavy: heavyCpu || memoryGb >= HEAVY_MEMORY_GB,
	};
}
