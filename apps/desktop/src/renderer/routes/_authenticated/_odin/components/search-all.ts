import Fuse from "fuse.js";
import { profileOf } from "shared/odin-profile";
import type { Pane, PaneStatus } from "shared/tabs-types";
import { repoLabel } from "../sessions/row-labels";

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
		.map((pane) => ({
			pane,
			title: pane.odinTaskTitle ?? mirror.titles[pane.id],
		}))
		.filter(
			({ pane, title }) =>
				pane.type === "terminal" &&
				!!title &&
				!pane.completed &&
				tabIds.has(pane.tabId) &&
				profileOf(pane.odinProfile) === profileId,
		)
		.map(({ pane, title }) => ({
			paneId: pane.id,
			title: title ?? "",
			status: pane.status ?? "idle",
			contact: pane.odinContact ?? mirror.contacts[pane.id] ?? null,
			repo: repoLabel(pane.cwd ?? pane.initialCwd),
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
 * extra fields (who, where, source, status). Rows that only match through a
 * typo sit below these at TYPO_TIER, and transcript hits, which only the
 * server can score, below all of them at TRANSCRIPT_TIER.
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

export const TYPO_TIER = 4;
export const TRANSCRIPT_TIER = 5;

/** Fuse's score is typos per letter typed: 1 in 4, 2 in 6, 3 in 9. */
const TYPO_THRESHOLD = 0.34;
/** Below this a word must be exact: one edit turns "fix" into "six". */
const MIN_TYPO_WORD = 4;

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

export const normalizeQuery = (query: string) =>
	query.trim().toLowerCase().replace(/\s+/g, " ");

type Fields<T> = (
	item: T,
) => [title: string, extra: (string | null | undefined)[]];

/** Items that match, best tier first; nothing typed matches everything at tier 0. */
function rankBy<T>(query: string, items: T[], fields: Fields<T>): Ranked<T>[] {
	const needle = normalizeQuery(query);
	const exact: Ranked<T>[] = [];
	const missed: T[] = [];
	for (const item of items) {
		const tier = needle ? matchRank(needle, ...fields(item)) : 0;
		if (tier === null) missed.push(item);
		else exact.push({ item, tier });
	}
	const typos = typoMatches(needle, missed, fields).map((item) => ({
		item,
		tier: TYPO_TIER,
	}));
	return [...exact, ...typos].sort((a, b) => a.tier - b.tier);
}

/** Items where every typed word turns up, give or take a typo. */
function typoMatches<T>(needle: string, items: T[], fields: Fields<T>): T[] {
	if (!needle || items.length === 0) return [];
	const texts = items.map((item) => {
		const [title, extra] = fields(item);
		return [title, ...extra].join(" ").toLowerCase();
	});
	const fuse = new Fuse(texts, {
		threshold: TYPO_THRESHOLD,
		ignoreLocation: true,
	});
	const matchesPerWord = needle
		.split(" ")
		.map((word) =>
			word.length < MIN_TYPO_WORD
				? new Set(texts.flatMap((text, i) => (text.includes(word) ? [i] : [])))
				: new Set(fuse.search(word).map((result) => result.refIndex)),
		);
	return items.filter((_, i) => matchesPerWord.every((hits) => hits.has(i)));
}

/**
 * Rows that match, best tier first, then open before done, then in the order
 * given (newest first, as allItems hands them over), so the palette opens on
 * what's open and current.
 */
export function rankRows<Row extends SearchableRow>(
	query: string,
	rows: Row[],
): Ranked<Row>[] {
	return rankBy(query, rows, (row) => [
		row.title,
		[row.source, row.person, row.context, row.status],
	]).sort(
		(a, b) => a.tier - b.tier || Number(!!a.item.done) - Number(!!b.item.done),
	);
}

/** Board cards that match, best tier first, then in the board's column order. */
export function rankSessions(
	query: string,
	sessions: SessionHit[],
): Ranked<SessionHit>[] {
	return rankBy(query, sessions, (session) => [
		session.title,
		[session.contact, session.repo, session.brief, ...session.tags],
	]);
}

export interface ResultGroup<T> {
	id: string;
	items: T[];
	/** How many more matched than the cap shows. */
	more: number;
}

/**
 * One header per source. Groups named in `first` lead in that order; the rest
 * follow, the group holding the best hit first (ties keep the order given).
 * Each shows `cap` hits unless it's been expanded - so forty transcript hits
 * can't bury the one feed row you meant.
 */
export function groupResults<T>(
	groups: { id: string; hits: Ranked<T>[] }[],
	cap: number,
	expanded: ReadonlySet<string>,
	first: readonly string[] = [],
): ResultGroup<T>[] {
	const pin = (id: string) => {
		const at = first.indexOf(id);
		return at === -1 ? first.length : at;
	};
	return groups
		.filter((group) => group.hits.length > 0)
		.sort(
			(a, b) =>
				pin(a.id) - pin(b.id) ||
				(a.hits[0]?.tier ?? 0) - (b.hits[0]?.tier ?? 0),
		)
		.map(({ id, hits }) => {
			const shown = expanded.has(id) ? hits.length : cap;
			return {
				id,
				items: hits.slice(0, shown).map((hit) => hit.item),
				more: Math.max(0, hits.length - shown),
			};
		});
}
