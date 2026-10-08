import { profileOf } from "shared/odin-profile";
import type { Pane, PaneStatus } from "shared/tabs-types";

/** A Dev Board session, as Search all lists it. */
export interface SessionHit {
	paneId: string;
	title: string;
	status: PaneStatus;
	contact: string | null;
	repo: string | null;
	/** The launch prompt and the card's tags - searched, not shown. */
	brief: string | null;
	tags: string[];
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
 * Every card the Dev Board draws for this profile, in every column, live or
 * not and whatever the board's filter: a terminal Odin launched (it carries a
 * task title, on the pane or in the older localStorage mirror), in a tab that
 * still exists, less the legacy killed ones.
 */
export function boardSessions(
	panes: Record<string, Pane>,
	tabIds: Set<string>,
	profileId: string,
	mirror: {
		titles: Record<string, string>;
		contacts: Record<string, string>;
		briefs: Record<string, string>;
	} = { titles: {}, contacts: {}, briefs: {} },
): SessionHit[] {
	return Object.values(panes)
		.filter(
			(pane) =>
				pane.type === "terminal" &&
				!!(pane.odinTaskTitle ?? mirror.titles[pane.id]) &&
				!pane.completed &&
				tabIds.has(pane.tabId) &&
				profileOf(pane.odinProfile) === profileId,
		)
		.map((pane) => ({
			paneId: pane.id,
			title: pane.odinTaskTitle ?? mirror.titles[pane.id] ?? "",
			status: pane.status ?? "idle",
			contact: pane.odinContact ?? mirror.contacts[pane.id] ?? null,
			repo:
				(pane.cwd ?? pane.initialCwd)?.split("/").filter(Boolean).pop() ?? null,
			brief: pane.odinBrief ?? mirror.briefs[pane.id] ?? null,
			tags: pane.odinTags ?? [],
		}))
		.sort(
			(a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
		);
}

/**
 * How well `needle` (lowercased) names a result - lower is better, null is no
 * match. 0: the title starts with it. 1: a word in the title does. 2: it's
 * somewhere in the title. 3: every typed word turns up in the title or the
 * extra fields (who, where, source, status). Transcript hits, which only the
 * server can score, sit below all of these at TRANSCRIPT_TIER.
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

export const TRANSCRIPT_TIER = 4;

/** A status that means the work is over - in any source's words. */
export function isClosedStatus(status: string | null | undefined): boolean {
	return /^(done|closed|resolved|completed?|merged|cancell?ed|won'?t (do|fix))$/i.test(
		status?.trim() ?? "",
	);
}

/** The fields Search all reads off a row - AllItem has them all. */
export interface SearchableRow {
	title: string;
	source: string;
	person: string | null;
	context: string | null;
	status: string | null;
	/** Done'd in Odin or closed upstream: still found, but after the open ones. */
	done?: boolean;
}

export interface Ranked<T> {
	item: T;
	tier: number;
}

const normalize = (query: string) =>
	query.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Rows that match, best tier first, then open before done, then in the order
 * given (newest first, as allItems hands them over). Nothing typed matches
 * everything at tier 0, so the palette opens on what's open and current.
 */
export function rankRows<Row extends SearchableRow>(
	query: string,
	rows: Row[],
): Ranked<Row>[] {
	const needle = normalize(query);
	return rows
		.flatMap((item) => {
			const tier = needle
				? matchRank(needle, item.title, [
						item.source,
						item.person,
						item.context,
						item.status,
					])
				: 0;
			return tier === null ? [] : [{ item, tier }];
		})
		.sort(
			(a, b) =>
				a.tier - b.tier || Number(!!a.item.done) - Number(!!b.item.done),
		);
}

/** Board cards that match, best tier first, then in the board's column order. */
export function rankSessions(
	query: string,
	sessions: SessionHit[],
): Ranked<SessionHit>[] {
	const needle = normalize(query);
	return sessions
		.flatMap((item) => {
			const tier = needle
				? matchRank(needle, item.title, [
						item.contact,
						item.repo,
						item.brief,
						...item.tags,
					])
				: 0;
			return tier === null ? [] : [{ item, tier }];
		})
		.sort((a, b) => a.tier - b.tier);
}

export interface ResultGroup<T> {
	id: string;
	items: T[];
	/** How many more matched than the cap shows. */
	more: number;
}

/**
 * One header per source. The group holding the best hit comes first (ties keep
 * the order given), and each shows `cap` hits unless it's been expanded - so
 * forty transcript hits can't bury the one feed row you meant.
 */
export function groupResults<T>(
	groups: { id: string; hits: Ranked<T>[] }[],
	cap: number,
	expanded: ReadonlySet<string>,
): ResultGroup<T>[] {
	return groups
		.filter((group) => group.hits.length > 0)
		.sort((a, b) => (a.hits[0]?.tier ?? 0) - (b.hits[0]?.tier ?? 0))
		.map(({ id, hits }) => {
			const shown = expanded.has(id) ? hits.length : cap;
			return {
				id,
				items: hits.slice(0, shown).map((hit) => hit.item),
				more: Math.max(0, hits.length - shown),
			};
		});
}
