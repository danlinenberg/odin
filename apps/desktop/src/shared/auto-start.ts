/**
 * Settings > Remote > Auto-start new tasks: while the remote host is on, a
 * task that shows up in one of the picked sources starts a session there on
 * its own. These are the sources Next in line takes tasks from.
 */
export const AUTO_START_SOURCES = [
	"Slack",
	"Jira",
	"GitHub",
	"Notion",
	"Tasks",
] as const;
export type AutoStartSource = (typeof AUTO_START_SOURCES)[number];

/** What each switch starts, as Settings shows it. */
export const AUTO_START_HINTS: Record<AutoStartSource, string> = {
	Slack: "A message you react to with the Queue emoji (default :eyes:).",
	Jira: "An issue new in your Jira feed.",
	GitHub: "A pull request new in your GitHub feed.",
	Notion: "A page new in your Notion feed.",
	Tasks: "A task you add to your own list.",
};

/** Keys kept per source; the oldest go first past this. */
const SEEN_CAP = 2000;

export interface AutoStartRow {
	source: string;
	key: string;
}

/**
 * Which rows are new since the last look. A task is new once: every key seen
 * is kept, per source. The first rows a source ever shows are its baseline -
 * what already waited when Auto-start first saw it - and none of them is
 * new, so connecting a source or turning the feature on starts nothing old.
 * `loaded` names the sources whose feed has answered: one that answered with
 * nothing waiting gets an empty baseline, so its first row after that is new
 * and starts, instead of becoming the baseline itself.
 * `rows` is every row a feed shows, not only the ones waiting: a task with a
 * session on it is seen too, so it is not new the day that session ends and
 * it waits again.
 */
export function newAutoStartRows(
	seen: Record<string, string[]> | undefined,
	rows: AutoStartRow[],
	loaded: readonly string[] = [],
): {
	fresh: AutoStartRow[];
	seen: Record<string, string[]>;
	/** Any key recorded: `seen` needs saving. */
	changed: boolean;
} {
	const next: Record<string, string[]> = { ...seen };
	const fresh: AutoStartRow[] = [];
	let changed = false;
	const bySource = new Map<string, AutoStartRow[]>();
	for (const row of rows)
		bySource.set(row.source, [...(bySource.get(row.source) ?? []), row]);
	for (const [source, sourceRows] of bySource) {
		const known = next[source];
		const keys = new Set(known);
		const added = sourceRows.filter((row) => !keys.has(row.key));
		if (added.length === 0) continue;
		changed = true;
		if (known) fresh.push(...added);
		// Past the cap, keys the feed no longer shows go first: dropping one it
		// still shows would make that old row new again, and start it.
		const shown = new Set(sourceRows.map((row) => row.key));
		const gone = (known ?? []).filter((key) => !shown.has(key));
		const room = Math.min(gone.length, Math.max(0, SEEN_CAP - shown.size));
		next[source] = [
			...gone.slice(gone.length - room),
			...(known ?? []).filter((key) => shown.has(key)),
			...new Set(added.map((row) => row.key)),
		];
	}
	for (const source of loaded) {
		if (next[source]) continue;
		next[source] = [];
		changed = true;
	}
	return { fresh, seen: next, changed };
}
