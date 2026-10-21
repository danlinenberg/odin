/** A remote host's memory and CPU at one moment, as `cat /proc/meminfo /proc/loadavg; nproc` reports them. */
export interface HostLoad {
	memAvailableMb: number;
	memTotalMb: number;
	load1: number;
	cores: number;
}

export interface HostLoadReading extends HostLoad {
	instanceId: string;
	/** When it was read, ms since epoch. */
	at: number;
}

/**
 * A command whose output `parseHostLoad` reads. The user slice's cgroup
 * figures come too: a host can cap it below its RAM, and a slice at its cap
 * freezes every session while /proc/meminfo still shows gigabytes free.
 */
export const HOST_LOAD_COMMAND =
	"cat /proc/meminfo /proc/loadavg; echo UserSliceCurrent: $(cat /sys/fs/cgroup/user.slice/memory.current 2>/dev/null); echo UserSliceMax: $(cat /sys/fs/cgroup/user.slice/memory.max 2>/dev/null); nproc";

/** The numbers in `HOST_LOAD_COMMAND`'s output, or null when any is missing. */
export function parseHostLoad(text: string): HostLoad | null {
	const kb = (field: string) =>
		Number(text.match(new RegExp(`^${field}:\\s+(\\d+)`, "m"))?.[1]);
	// /proc/loadavg: "0.52 0.58 0.59 1/389 12345"; nproc: a bare number on the last line.
	const load1 = Number(text.match(/^(\d+\.\d+) \d+\.\d+ \d+\.\d+ /m)?.[1]);
	const cores = Number(text.trim().split("\n").pop());
	// Bytes, unlike meminfo's kB. "max" (no cap) or a missing file reads NaN.
	const slice = (field: string) =>
		Number(text.match(new RegExp(`^UserSlice${field}: (\\d+)$`, "m"))?.[1]);
	const sliceFreeKb = (slice("Max") - slice("Current")) / 1024;
	const load = {
		memAvailableMb: Math.round(
			Math.min(
				kb("MemAvailable"),
				Number.isFinite(sliceFreeKb) ? Math.max(0, sliceFreeKb) : Infinity,
			) / 1024,
		),
		memTotalMb: Math.round(kb("MemTotal") / 1024),
		load1,
		cores,
	};
	return Object.values(load).every(Number.isFinite) && load.memTotalMb > 0
		? load
		: null;
}

/** Free memory below which a host's sessions stall: typing and output stop. */
export const HOST_FROZEN_FREE_MB = 512;
