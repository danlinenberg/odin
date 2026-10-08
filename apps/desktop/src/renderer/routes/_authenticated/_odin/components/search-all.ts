import { type BoardSection, boardSection } from "shared/board-section";
import { profileOf } from "shared/odin-profile";
import type { Pane, PaneStatus } from "shared/tabs-types";

/** A Dev Board session, as Search all lists it. */
export interface SessionHit {
	paneId: string;
	title: string;
	status: PaneStatus;
	source: BoardSection;
	contact: string | null;
	repo: string | null;
}

/** Needs-you first, the board's own column order. */
const STATUS_ORDER: PaneStatus[] = [
	"permission",
	"working",
	"review",
	"idle",
	"failed",
];

/**
 * Every session the Dev Board draws for this profile, live or not - the board's
 * own rule: a terminal Odin launched (it carries a task title), in a tab that
 * still exists, less the legacy killed ones.
 */
export function boardSessions(
	panes: Record<string, Pane>,
	tabIds: Set<string>,
	profileId: string,
): SessionHit[] {
	return Object.values(panes)
		.filter(
			(pane) =>
				pane.type === "terminal" &&
				!!pane.odinTaskTitle &&
				!pane.completed &&
				tabIds.has(pane.tabId) &&
				profileOf(pane.odinProfile) === profileId,
		)
		.map((pane) => ({
			paneId: pane.id,
			title: pane.odinTaskTitle ?? "",
			status: pane.status ?? "idle",
			source: boardSection(pane),
			contact: pane.odinContact ?? null,
			repo:
				(pane.cwd ?? pane.initialCwd)?.split("/").filter(Boolean).pop() ?? null,
		}))
		.sort(
			(a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
		);
}

/**
 * How well `needle` (lowercased) names a result - lower is better, null is no
 * match. The title starting with it beats a word in the title starting with
 * it, which beats it anywhere in the title. Failing all three, every typed
 * word has to turn up in the title or the extra fields (who, where, source).
 */
export function matchRank(
	needle: string,
	title: string,
	extra: (string | null | undefined)[],
): number | null {
	const text = title.toLowerCase();
	const at = text.indexOf(needle);
	if (at === 0) return 0;
	if (at > 0) return /[a-z0-9]/.test(text[at - 1] ?? "") ? 2 : 1;
	const haystack = [text, ...extra.map((field) => field?.toLowerCase())].join(
		" ",
	);
	return needle.split(" ").every((word) => haystack.includes(word)) ? 3 : null;
}

/** The fields Search all reads off a feed row - AllItem has them all. */
interface SearchableRow {
	title: string;
	source: string;
	person: string | null;
	context: string | null;
	status: string | null;
}

function ranked<T>(list: T[], rank: (item: T) => number | null, limit: number) {
	return list
		.flatMap((item) => {
			const score = rank(item);
			return score === null ? [] : [{ item, score }];
		})
		.sort((a, b) => a.score - b.score)
		.slice(0, limit)
		.map(({ item }) => item);
}

/**
 * Search all's results: sessions and feed rows, each best match first and
 * otherwise in the order given (the board's, newest row first). Nothing typed
 * lists the first `limit` of each, so the palette opens on what's current.
 */
export function searchAll<Row extends SearchableRow>(
	query: string,
	rows: Row[],
	sessions: SessionHit[],
	limit = 30,
): { sessions: SessionHit[]; rows: Row[] } {
	const needle = query.trim().toLowerCase().replace(/\s+/g, " ");
	if (!needle)
		return { sessions: sessions.slice(0, limit), rows: rows.slice(0, limit) };
	return {
		sessions: ranked(
			sessions,
			(session) =>
				matchRank(needle, session.title, [session.contact, session.repo]),
			limit,
		),
		rows: ranked(
			rows,
			(row) =>
				matchRank(needle, row.title, [
					row.source,
					row.person,
					row.context,
					row.status,
				]),
			limit,
		),
	};
}
