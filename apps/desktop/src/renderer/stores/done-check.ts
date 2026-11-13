/** What Done put away, and the check for it - no React: the phone server on a remote host uses it. */

/** A row as it looked when it was done - it may have left its feed since. */
export interface DoneRow {
	at: number;
	title: string;
	source: string;
	url: string | null;
	/** Put away to read later, not finished - All tasks' Reading material. */
	reading?: boolean;
	/**
	 * A session moved to Docs off the board: where it ran, so Docs' Back to
	 * board can resume it there without reading its transcript first.
	 */
	cwd?: string;
	/** Put away by a "drop tasks like this" rule - removing the rule brings it back. */
	rule?: string;
}

/**
 * A meeting's link is its call, shared by every occurrence of a series and by
 * every meeting in someone's personal room - it names a place, not the task.
 */
const linkIsTheTask = (key: string) => !key.startsWith("meeting:");

/**
 * Is this row done? By key, or by link for PRs, which the feeds key by id and
 * the sweep by repo#n. A mention newer than the Done brings the row back -
 * someone asked me something on it since - and Done again puts it away.
 */
export function doneChecker(done: Record<string, DoneRow>) {
	const byUrl = new Map(
		Object.entries(done).flatMap(([key, row]) =>
			row.url && linkIsTheTask(key) ? [[row.url, row] as const] : [],
		),
	);
	return (item: {
		key: string;
		url?: string | null;
		mention?: { at?: string | null } | null;
	}) => {
		const row =
			done[item.key] ??
			(item.url && linkIsTheTask(item.key) ? byUrl.get(item.url) : null);
		const askedAt = Date.parse(item.mention?.at ?? "");
		return !!row && !(askedAt > row.at);
	};
}
