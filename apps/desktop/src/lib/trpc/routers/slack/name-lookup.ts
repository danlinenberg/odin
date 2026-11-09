/** How long a name Slack wouldn't give (no access, a deleted user) isn't asked again. */
const MISS_MS = 10 * 60_000;

/**
 * Names by Slack id: a cached name, or one Slack call for it. A miss is kept
 * for a while and a lookup already on the wire is shared: the phone's board
 * asks every few seconds, and an uncached miss used to go back to Slack each
 * time, into its rate limit and the minute-long Retry-After wait behind it.
 */
export function createNameLookup(now: () => number = Date.now) {
	const names = new Map<string, string>();
	const misses = new Map<string, number>();
	const pending = new Map<string, Promise<string | null>>();
	return {
		get(id: string, ask: () => Promise<string | null>): Promise<string | null> {
			const cached = names.get(id);
			if (cached) return Promise.resolve(cached);
			const missedAt = misses.get(id);
			if (missedAt !== undefined && now() - missedAt < MISS_MS)
				return Promise.resolve(null);
			let lookup = pending.get(id);
			if (!lookup) {
				lookup = ask()
					.catch(() => null)
					.then((name) => {
						if (name) names.set(id, name);
						else misses.set(id, now());
						return name;
					})
					.finally(() => pending.delete(id));
				pending.set(id, lookup);
			}
			return lookup;
		},
		clear() {
			names.clear();
			misses.clear();
		},
	};
}

export interface SlackUser {
	name?: string;
	real_name?: string;
	profile?: { display_name?: string; real_name?: string };
}

/**
 * A person's name the way Slack shows it in an @mention and on their messages:
 * the display name they chose, else their full name. Someone whose full name
 * is "Ana Maria Lopez" may be tagged "@Ana Lopez", and a draft showing the full
 * name looked like it tagged the wrong person.
 */
export function slackUserName(user: SlackUser | undefined): string | null {
	return (
		user?.profile?.display_name?.trim() ||
		user?.real_name?.trim() ||
		user?.profile?.real_name?.trim() ||
		user?.name ||
		null
	);
}
