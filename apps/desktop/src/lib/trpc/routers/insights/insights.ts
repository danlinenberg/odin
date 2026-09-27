/**
 * What lands on you and what you do with it.
 *
 * Everything here is arithmetic over rows Odin already keeps — no model call,
 * no network. Two stores answer different halves: `slack_reactions` has the
 * long history (every ask seen, whether it was picked up), while `work_log`
 * spans all four feeds but only since it landed. Neither is asked a question
 * it can't answer.
 */

export interface AskRow {
	firstSeenAt: number;
	startedAt: number | null;
	doneAt: number | null;
	unreactedAt: number | null;
	authorName: string | null;
	channelId?: string;
	channelName?: string | null;
}

/** An area — a channel or a person — whose asks you mostly leave lying. */
export interface Gap {
	kind: "channel" | "person";
	name: string;
	seen: number;
	/** Started on or marked done. */
	handled: number;
	/** Still live and untouched. */
	waiting: number;
}

export interface DelegationRow {
	source: string;
	person: string | null;
	startedAt: number;
}

export interface Insights {
	/** Every ask Odin has ever seen land on you. */
	seen: number;
	/** Asks an agent was started on. */
	delegated: number;
	/** Asks marked handled. */
	done: number;
	/** Still sitting there: not started, not done, reaction still on. */
	waiting: number;
	/**
	 * Hours from an ask appearing to an agent being started on it. Median
	 * rather than mean — one thread left overnight would otherwise swamp a
	 * week of same-minute pickups.
	 */
	medianPickupHours: number | null;
	slowestPickupHours: number | null;
	/** Who asks most, biggest first. */
	askers: { name: string; asks: number }[];
	/** Delegations per feed, from the ledger. Empty until it fills. */
	bySource: { source: string; count: number }[];
	/** Ledger rows total — how much history the numbers above stand on. */
	delegationsLogged: number;
	/** Channels and people you pick up least, never-touched first. */
	gaps: Gap[];
}

/** Middle value, averaging the two middles on an even count. */
export function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Round to one decimal, so "0.4h" doesn't render as 0.35000000000000003. */
function hours(ms: number): number {
	return Math.round((ms / 3_600_000) * 10) / 10;
}

/** Count by a key, biggest first, ties broken by name so the order is stable. */
function tally<T>(
	rows: T[],
	key: (row: T) => string | null,
): { name: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const name = key(row);
		if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return [...counts]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

const isWaiting = (ask: AskRow): boolean =>
	ask.startedAt === null && ask.doneAt === null && ask.unreactedAt === null;

/**
 * Areas where under half the asks got handled. A single ask says nothing about
 * a habit, so an area needs `minAsks` before it's held against you. DMs have
 * no channel name and one each, so they fold into one "DMs" area.
 */
export function findGaps(asks: AskRow[], minAsks = 2, limit = 8): Gap[] {
	const groups = new Map<string, Gap>();
	const add = (kind: Gap["kind"], name: string | null, ask: AskRow) => {
		if (!name) return;
		const key = `${kind}:${name}`;
		const gap = groups.get(key) ?? {
			kind,
			name,
			seen: 0,
			handled: 0,
			waiting: 0,
		};
		gap.seen++;
		if (ask.startedAt !== null || ask.doneAt !== null) gap.handled++;
		if (isWaiting(ask)) gap.waiting++;
		groups.set(key, gap);
	};
	for (const ask of asks) {
		const dm = ask.channelId?.startsWith("D");
		add(
			"channel",
			dm ? "DMs" : (ask.channelName ?? ask.channelId ?? null),
			ask,
		);
		add("person", ask.authorName, ask);
	}
	return [...groups.values()]
		.filter((gap) => gap.seen >= minAsks && gap.handled * 2 < gap.seen)
		.sort(
			(a, b) =>
				a.handled / a.seen - b.handled / b.seen ||
				b.seen - a.seen ||
				a.name.localeCompare(b.name),
		)
		.slice(0, limit);
}

export function computeInsights(
	asks: AskRow[],
	delegations: DelegationRow[],
	topAskers = 6,
): Insights {
	// Only asks actually picked up have a pickup time, and a clock skew that
	// puts the start before the sighting would otherwise read as negative.
	const pickups = asks
		.filter((ask) => ask.startedAt !== null)
		.map((ask) => Math.max(0, (ask.startedAt as number) - ask.firstSeenAt));

	return {
		seen: asks.length,
		delegated: pickups.length,
		done: asks.filter((ask) => ask.doneAt !== null).length,
		// Untouched and still live. An ask whose reaction came off was withdrawn,
		// not ignored, so it isn't held against you here.
		waiting: asks.filter(isWaiting).length,
		medianPickupHours: pickups.length ? hours(median(pickups) as number) : null,
		slowestPickupHours: pickups.length ? hours(Math.max(...pickups)) : null,
		askers: tally(asks, (ask) => ask.authorName)
			.slice(0, topAskers)
			.map(({ name, count }) => ({ name, asks: count })),
		bySource: tally(delegations, (row) => row.source).map(
			({ name, count }) => ({ source: name, count }),
		),
		delegationsLogged: delegations.length,
		gaps: findGaps(asks),
	};
}
