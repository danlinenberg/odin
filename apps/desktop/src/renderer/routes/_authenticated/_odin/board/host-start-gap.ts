/**
 * Time between two Claudes starting on one remote host. A `claude --resume`
 * there reads its whole conversation as it starts; six at once froze them for
 * over ten minutes, with tmux still drawing its clock, so the pane looked live
 * and took no keys.
 */
export const HOST_START_GAP_MS = 15_000;

/** When each host may start its next Claude. */
const nextStartAt = new Map<string, number>();

/** Books this host's next start; returns how long to wait for it. */
export function hostStartDelay(
	host: string,
	now = Date.now(),
	gap = HOST_START_GAP_MS,
): number {
	const at = Math.max(now, nextStartAt.get(host) ?? 0);
	nextStartAt.set(host, at + gap);
	return at - now;
}
