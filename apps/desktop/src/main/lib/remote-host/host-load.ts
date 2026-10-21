import {
	HOST_LOAD_COMMAND,
	type HostLoadReading,
	parseHostLoad,
} from "shared/host-load";
import { HOST_LOAD_FRESH_MS } from "shared/launch-gate";
import { connectHost, type HostLogin, runOnHost } from "./ssh";

/**
 * The latest memory and load reading per host instance. Remote panes send one
 * every 30s over the connection they already hold (POST /remote-host/load);
 * with none open, a launch probes once.
 */
const readings = new Map<string, HostLoadReading>();

export function recordHostLoad(reading: HostLoadReading): void {
	const known = readings.get(reading.instanceId);
	if (!known || known.at <= reading.at)
		readings.set(reading.instanceId, reading);
}

/** The host's latest reading, if it is recent enough to say how it is now. */
function freshHostLoad(
	instanceId: string,
	now = Date.now(),
): HostLoadReading | null {
	const reading = readings.get(instanceId);
	return reading && now - reading.at <= HOST_LOAD_FRESH_MS ? reading : null;
}

const probes = new Map<string, Promise<HostLoadReading | null>>();
const failedAt = new Map<string, number>();

/**
 * One reading over a connection of its own, closed straight after. A failed
 * probe returns null and isn't retried for a while: an unreachable host gets
 * no more connections from here, and the launch goes ahead as before.
 */
function probe(host: HostLogin): Promise<HostLoadReading | null> {
	const { instanceId } = host;
	const running = probes.get(instanceId);
	if (running) return running;
	if (Date.now() - (failedAt.get(instanceId) ?? 0) < HOST_LOAD_FRESH_MS)
		return Promise.resolve(null);
	const next = (async () => {
		const client = await connectHost(host);
		try {
			const load = parseHostLoad(await runOnHost(client, HOST_LOAD_COMMAND));
			if (!load) throw new Error("unreadable /proc output");
			const reading = { ...load, instanceId, at: Date.now() };
			recordHostLoad(reading);
			return reading;
		} finally {
			client.end();
		}
	})()
		.catch((error: unknown) => {
			console.warn("[remote-host] load probe:", error);
			failedAt.set(instanceId, Date.now());
			return null;
		})
		.finally(() => probes.delete(instanceId));
	probes.set(instanceId, next);
	return next;
}

/**
 * The host's fresh reading, else one probe's. A launch waits at most
 * `waitMs` for the probe (a busy host can take minutes to answer); the probe
 * still finishes and caches its reading for the next launch.
 */
export async function hostLoad(
	host: HostLogin,
	waitMs = 15_000,
): Promise<HostLoadReading | null> {
	const fresh = freshHostLoad(host.instanceId);
	if (fresh) return fresh;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), waitMs);
	});
	return Promise.race([probe(host), timeout]).finally(() =>
		clearTimeout(timer),
	);
}
