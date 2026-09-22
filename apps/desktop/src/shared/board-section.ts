import type { Pane } from "./tabs-types";

/**
 * Where a session came from — the sections inside a board column, so a column
 * of nine cards reads as "four Slack threads, two Jira, three of mine" instead
 * of one undifferentiated list.
 */
export type BoardSection =
	| "queued"
	| "parked"
	| "slack"
	| "reactions"
	| "jira"
	| "pr"
	| "notion"
	| "normal";

export const SECTION_LABEL: Record<BoardSection, string> = {
	queued: "Queued",
	parked: "Parked",
	slack: "Slack",
	reactions: "Slack",
	jira: "Jira",
	pr: "GitHub",
	notion: "Notion",
	normal: "Normal",
};

/** Someone-is-waiting first, my own prompts last. */
const ORDER: BoardSection[] = ["reactions", "jira", "pr", "notion", "normal"];

export function boardSection(pane: Pane): BoardSection {
	// "slack" is the retired Slack-queue source, still stored on old panes — it
	// lands in the one Slack section with the reaction cards.
	if (pane.odinSource)
		return pane.odinSource === "slack" ? "reactions" : pane.odinSource;
	// Panes launched before odinSource existed only carry a Notion pageId.
	return pane.odinPageId ? "reactions" : "normal";
}

/** Created but not started yet — waiting on the Mac, or on Odin's checkout. */
function isQueued(pane: Pane): boolean {
	return !!pane.odinQueued;
}

/**
 * A session you put down on purpose. Only in Idle: the board clears the flag
 * the moment a parked session starts moving again, so this is never a live one.
 */
function isParked(pane: Pane): boolean {
	return !!pane.odinParked && (pane.status ?? "idle") === "idle";
}

/**
 * Cards grouped into sections, empty sections dropped, order fixed.
 *
 * Queued and Parked come first and cut across the source sections: one hasn't
 * started yet and the other you put down on purpose, so neither is an Idle
 * card asking to be resumed, whichever feed started it.
 */
export function bySection<T extends { pane: Pane }>(
	cards: T[],
): [BoardSection, T[]][] {
	const rest = cards.filter(
		(card) => !isParked(card.pane) && !isQueued(card.pane),
	);
	return (
		[
			["queued", cards.filter((card) => isQueued(card.pane))],
			[
				"parked",
				cards.filter((card) => isParked(card.pane) && !isQueued(card.pane)),
			],
			...ORDER.map((section) => [
				section,
				rest.filter((card) => boardSection(card.pane) === section),
			]),
		] as [BoardSection, T[]][]
	).filter(([, group]) => group.length > 0);
}
