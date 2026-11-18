/**
 * The Today page's "Coming up" list: your tasks that are due soon or late,
 * the top of Up next you have not started yet, and what waits on someone
 * else. Built only from what Tasks already keeps.
 */

/** A task row as the Coming up list reads it. */
export interface SideRow {
	key: string;
	title: string;
	source: string;
	url: string | null;
	/** Local `YYYY-MM-DD`: your own date over the source's. */
	due: string | null;
	/** A session runs on it now. */
	started: boolean;
}

export interface SideWaiting {
	key: string;
	title: string;
	/** Who or what it waits on. Empty when you didn't say. */
	on: string;
	/** Local `YYYY-MM-DD` it comes back on Up next. */
	until: string;
	url: string | null;
	source: string | null;
	started: boolean;
}

export interface TodaySide {
	due: (SideRow & { daysLeft: number })[];
	upNext: SideRow[];
	waiting: SideWaiting[];
}

/** Due within this many days counts as "due this week". */
export const DUE_SOON_DAYS = 6;
/** How much of Up next Coming up shows. */
export const UP_NEXT_SHOWN = 5;

/**
 * Due: late or due within the week, nearest first. Up next: the queue's top
 * rows with no session yet and not already listed as due. Waiting: every
 * parked row, the one coming back first on top. A waiting row is never
 * listed as due or up next too.
 */
export function todaySide({
	rows,
	queue,
	waiting,
	daysUntil,
}: {
	rows: SideRow[];
	queue: string[];
	waiting: Record<string, { on: string; until: string; title?: string }>;
	daysUntil: (day: string) => number;
}): TodaySide {
	const byKey = new Map(rows.map((row) => [row.key, row]));
	const parked = new Set(Object.keys(waiting));
	const due = rows
		.filter((row) => row.due && !parked.has(row.key))
		.map((row) => ({ ...row, daysLeft: daysUntil(row.due as string) }))
		.filter((row) => row.daysLeft <= DUE_SOON_DAYS)
		.sort((a, b) => a.daysLeft - b.daysLeft);
	const listed = new Set(due.map((row) => row.key));
	const upNext = queue
		.map((key) => byKey.get(key))
		.filter(
			(row): row is SideRow =>
				!!row && !row.started && !listed.has(row.key) && !parked.has(row.key),
		)
		.slice(0, UP_NEXT_SHOWN);
	const waitingRows = Object.entries(waiting)
		.map(([key, wait]) => {
			const row = byKey.get(key);
			return {
				key,
				title: row?.title ?? wait.title ?? "A task",
				on: wait.on,
				until: wait.until,
				url: row?.url ?? null,
				source: row?.source ?? null,
				started: row?.started ?? false,
			};
		})
		.sort((a, b) => (a.until < b.until ? -1 : a.until > b.until ? 1 : 0));
	return { due, upNext, waiting: waitingRows };
}

/** The task picked after a step down (1) or up (-1); null on an empty page. */
export function moveSelection(
	step: 1 | -1,
	current: number,
	count: number,
): number | null {
	if (count === 0) return null;
	if (current < 0) return 0;
	return Math.min(Math.max(current + step, 0), count - 1);
}
