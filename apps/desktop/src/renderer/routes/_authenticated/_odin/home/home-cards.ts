import type { Pane, PaneStatus } from "renderer/stores/tabs/types";

export interface HomeCard {
	pane: Pane;
	column: "permission" | "working";
}

/**
 * The sessions Home shows: the board's Needs you and Working cards, in the
 * order given, with a live Claude to show. `columnOf` is the board's own
 * (useBoardColumns), and `alive` its agent set. A session the board closed
 * for sitting idle keeps its Needs you column there, but has nothing live to
 * show here, so it stays on the board.
 */
export function homeCards(
	panes: Pane[],
	columnOf: (pane: Pane) => PaneStatus,
	alive: Set<string>,
): HomeCard[] {
	const picked: HomeCard[] = [];
	for (const pane of panes) {
		if (!alive.has(pane.id)) continue;
		const column = columnOf(pane);
		if (column === "permission" || column === "working")
			picked.push({ pane, column });
	}
	return picked;
}

/**
 * Where the cards sit: the saved order for the ones still on Home, then any
 * new arrival at the end, in the order they're listed. One that left drops
 * out, so coming back puts it at the end too. A status change moves nothing.
 */
export function homeOrder(saved: string[], present: string[]): string[] {
	const here = new Set(present);
	const kept = saved.filter((id) => here.has(id));
	const known = new Set(kept);
	return [...kept, ...present.filter((id) => !known.has(id))];
}

/** Put `id` where `target` is, shifting the cards between them by one. */
export function moveCard(
	order: string[],
	id: string,
	target: string,
): string[] {
	const from = order.indexOf(id);
	const to = order.indexOf(target);
	if (from < 0 || to < 0 || from === to) return order;
	const next = order.filter((other) => other !== id);
	next.splice(to, 0, id);
	return next;
}

/** The grid is GRID_COLUMNS wide, so a card can be a half or a third of a row. */
export const GRID_COLUMNS = 6;

/**
 * How many rows fill one screen, and each card's width in grid columns, by
 * its place in the order. Up to 3 share one row, 4 make 2x2, 5 are 3 over 2,
 * and 6 or more are 3 a row - past six the rows keep that height and scroll.
 */
export function homeGrid(count: number): { rows: number; spans: number[] } {
	const rows = count <= 3 ? 1 : 2;
	const spans = Array.from({ length: count }, (_, index) => {
		if (count <= 3) return GRID_COLUMNS / count;
		if (count === 4) return GRID_COLUMNS / 2;
		if (count === 5 && index >= 3) return GRID_COLUMNS / 2;
		return GRID_COLUMNS / 3;
	});
	return { rows, spans };
}
