/**
 * A session's priority on the board: High, Medium or Low, set from the card's
 * right-click menu. Absent means none. Cards sort by it inside every section of
 * every column, so a High card stays on top when it moves from Working to
 * Needs you to Idle.
 */
export type SessionPriority = "high" | "medium" | "low";

export const SESSION_PRIORITIES: SessionPriority[] = ["high", "medium", "low"];

export const PRIORITY_LABEL: Record<SessionPriority, string> = {
	high: "High",
	medium: "Medium",
	low: "Low",
};

// No priority sits between Medium and Low: Low is how you push a card down.
const RANK: Record<SessionPriority | "none", number> = {
	high: 0,
	medium: 1,
	none: 2,
	low: 3,
};

export const priorityRank = (priority?: SessionPriority): number =>
	RANK[priority ?? "none"];

/** Highest priority first. Array sorts are stable, so ties keep their order. */
export const byPriority = (
	a: { pane: { odinPriority?: SessionPriority } },
	b: { pane: { odinPriority?: SessionPriority } },
): number =>
	priorityRank(a.pane.odinPriority) - priorityRank(b.pane.odinPriority);
