import type { Pane } from "./tabs-types";

/**
 * Where a session came from — the sections inside a board column, so a column
 * of nine cards reads as "four Slack threads, two Jira, three of mine" instead
 * of one undifferentiated list.
 */
export type BoardSection =
	| "slack"
	| "reactions"
	| "jira"
	| "pr"
	| "notion"
	| "normal";

export const SECTION_LABEL: Record<BoardSection, string> = {
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

/** Cards grouped into sections, empty sections dropped, order fixed. */
export function bySection<T extends { pane: Pane }>(
	cards: T[],
): [BoardSection, T[]][] {
	return ORDER.map(
		(section) =>
			[
				section,
				cards.filter((card) => boardSection(card.pane) === section),
			] as [BoardSection, T[]],
	).filter(([, group]) => group.length > 0);
}
