import type { Pane, PaneStatus } from "renderer/stores/tabs/types";

export interface HomeCard {
	pane: Pane;
	column: "permission" | "working";
}

/**
 * The sessions Home shows: the board's Needs you and Working cards, in the
 * order given. `columnOf` is the board's own (useBoardColumns), and `alive`
 * its agent set, which also keeps the board's completed panes off.
 */
export function homeCards(
	panes: Pane[],
	columnOf: (pane: Pane) => PaneStatus,
	alive: Set<string>,
): HomeCard[] {
	const picked: HomeCard[] = [];
	for (const pane of panes) {
		if (pane.completed && !alive.has(pane.id)) continue;
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

/**
 * The grid: its columns, and how many rows fill one screen. 1 fills it, 2 sit
 * side by side, 3-4 make a 2x2, 5 and up a 3x2 - past six the rows keep that
 * height and the page scrolls.
 */
export function homeGrid(count: number): { cols: number; rows: number } {
	if (count <= 1) return { cols: 1, rows: 1 };
	if (count === 2) return { cols: 2, rows: 1 };
	if (count <= 4) return { cols: 2, rows: 2 };
	return { cols: 3, rows: 2 };
}
