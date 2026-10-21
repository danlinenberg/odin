import type { PaneStatus } from "renderer/stores/tabs/types";

/** The drawer session list's sort options - value to menu label. */
export const SWITCH_SORTS = {
	status: "Needs you first",
	updated: "Last update",
	oldest: "Waiting longest",
	name: "Name",
} as const;
export type SwitchSort = keyof typeof SWITCH_SORTS;
/** The same sorts in a word, for a session list too narrow for the long labels. */
export const SWITCH_SORTS_SHORT: Record<SwitchSort, string> = {
	status: "Needs you",
	updated: "Updated",
	oldest: "Waiting",
	name: "Name",
};

/** What the order reads off a card: the column it sits in, its star, and when it got there. */
export interface OrderedCard {
	status: PaneStatus;
	pane: { odinStarred?: boolean; odinStatusAt?: number };
}

/** When the session entered its current state; 0 for a card never stamped. */
export const statusAt = (card: OrderedCard): number =>
	card.pane.odinStatusAt ?? 0;

// "Needs you first" treats a question and a finished turn alike: both want you.
const STATUS_RANK: Partial<Record<PaneStatus, number>> = {
	permission: 0,
	review: 0,
	working: 1,
};
// Grouped: Needs you, then Done, then Working.
const GROUP_RANK: Partial<Record<PaneStatus, number>> = {
	permission: 0,
	review: 1,
	working: 2,
};
const rank = (table: Partial<Record<PaneStatus, number>>, status: PaneStatus) =>
	table[status] ?? Object.keys(table).length;

/**
 * Order for the drawer's session list: the group (when grouped), starred first,
 * then the picked sort.
 *
 * The time sorts read only when a session entered its state. A working
 * session's hooks fire on every tool call, and sorting on them had the Working
 * rows trade places every few seconds. A session moves in the list when its
 * state changes - a question, a turn ending - and holds still while it works.
 */
export function sessionOrder<T extends OrderedCard>(
	sort: SwitchSort,
	grouped: boolean,
	title: (card: T) => string,
): (a: T, b: T) => number {
	return (a, b) =>
		(grouped ? rank(GROUP_RANK, a.status) - rank(GROUP_RANK, b.status) : 0) ||
		Number(!!b.pane.odinStarred) - Number(!!a.pane.odinStarred) ||
		(sort === "status"
			? rank(STATUS_RANK, a.status) - rank(STATUS_RANK, b.status)
			: 0) ||
		(sort === "name"
			? title(a).localeCompare(title(b))
			: sort === "oldest"
				? statusAt(a) - statusAt(b)
				: statusAt(b) - statusAt(a));
}
