import { reconnectStopped, remoteConnectLine } from "shared/odin-screen-status";

/** A remote pane whose login to its host failed: retrying, or stopped. */
export function loginFailing(screen: string): boolean {
	const line = remoteConnectLine(screen);
	return (
		!!line && (line.startsWith("Could not reconnect") || reconnectStopped(line))
	);
}

/**
 * Hosts where at least `min` sessions can't log in: one stuck pane is a bad
 * connection, several on one host are the host itself (out of memory, sshd
 * not answering). Each such host gets one banner on the board, not a red box
 * per session to work through.
 */
export function hostsNotTakingLogins(
	failingHosts: string[],
	min = 2,
): { host: string; sessions: number }[] {
	const counts = new Map<string, number>();
	for (const host of failingHosts)
		counts.set(host, (counts.get(host) ?? 0) + 1);
	return [...counts]
		.filter(([, sessions]) => sessions >= min)
		.map(([host, sessions]) => ({ host, sessions }));
}
