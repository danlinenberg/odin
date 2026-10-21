import type { ProfileReview } from "../hooks/useBacklogReview";

/**
 * All's Done shelf is the graveyard: everything put away, done or dropped, in
 * one list with the way back. A dropped row - by Review's sweep, by hand, or
 * by a "drop tasks like this" rule - is Done in the store like any other, so
 * the shelf asks Review which rows were dropped, and why, to say so.
 */

/**
 * Why each dropped row went, by its key and by its link, under any profile:
 * the Done store is one list for all of them, so a drop made under another
 * profile still reads as a drop here. PRs are keyed by id in the feeds and by
 * repo#number in the sweep; the link is what joins them.
 */
export function droppedWhy(
	profiles: Record<string, Pick<ProfileReview, "dropped"> | undefined>,
): Map<string, string> {
	const why = new Map<string, string>();
	for (const review of Object.values(profiles))
		for (const row of review?.dropped ?? []) {
			why.set(row.key, row.evidence);
			if (row.url) why.set(row.url, row.evidence);
		}
	return why;
}

/**
 * How a shelf row went: the drop's evidence when it was dropped, nothing when
 * it was done. A rule's drop has no sweep row behind it; the rule is the why.
 */
export function putAwayWhy(
	row: { key: string; url?: string | null; rule?: string },
	dropped: ReadonlyMap<string, string>,
): string | null {
	return (
		dropped.get(row.key) ??
		(row.url ? dropped.get(row.url) : undefined) ??
		(row.rule
			? "Dropped by a rule - Dropped automatically, under Filter"
			: null)
	);
}
