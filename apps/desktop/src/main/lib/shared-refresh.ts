const inFlight = new Map<string, Promise<unknown>>();

/**
 * Run one token refresh per key at a time; callers who ask while it runs get
 * its result. Refresh tokens rotate and work once, so after a wake from sleep
 * the probe and every feed refreshing at once spent the same token: one got
 * the new pair, the rest were refused and the row said "signed out". Key by
 * the refresh token itself, so the next refresh (with the rotated token) runs
 * on its own.
 */
export function sharedRefresh<T>(
	key: string,
	refresh: () => Promise<T>,
): Promise<T> {
	const running = inFlight.get(key);
	if (running) return running as Promise<T>;
	const next = refresh().finally(() => inFlight.delete(key));
	inFlight.set(key, next);
	return next;
}
