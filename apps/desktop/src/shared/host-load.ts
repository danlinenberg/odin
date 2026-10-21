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

/** A command whose output `parseHostLoad` reads. */
export const HOST_LOAD_COMMAND = "cat /proc/meminfo /proc/loadavg; nproc";

/** The numbers in `HOST_LOAD_COMMAND`'s output, or null when any is missing. */
export function parseHostLoad(text: string): HostLoad | null {
	const kb = (field: string) =>
		Number(text.match(new RegExp(`^${field}:\\s+(\\d+)`, "m"))?.[1]);
	// /proc/loadavg: "0.52 0.58 0.59 1/389 12345"; nproc: a bare number on the last line.
	const load1 = Number(text.match(/^(\d+\.\d+) \d+\.\d+ \d+\.\d+ /m)?.[1]);
	const cores = Number(text.trim().split("\n").pop());
	const load = {
		memAvailableMb: Math.round(kb("MemAvailable") / 1024),
		memTotalMb: Math.round(kb("MemTotal") / 1024),
		load1,
		cores,
	};
	return Object.values(load).every(Number.isFinite) && load.memTotalMb > 0
		? load
		: null;
}
