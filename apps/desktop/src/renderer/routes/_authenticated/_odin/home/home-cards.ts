import type { Pane } from "renderer/stores/tabs/types";
import { boardColumn } from "shared/board-column";

/** As many terminals as stay readable side by side: a 3x2 split. */
export const HOME_LIMIT = 6;

export interface HomeCard {
	pane: Pane;
	column: "permission" | "working";
}

/**
 * The sessions Home shows: the board's Needs you and Working cards, Needs you
 * first and the most recent status change first within each, cut at
 * HOME_LIMIT. `more` is how many didn't fit.
 *
 * The column is the board's own `boardColumn`, with the inputs the profile
 * picker's counts use - see boardCountsByProfile.
 */
export function homeCards(
	panes: Pane[],
	alive: Set<string>,
): { cards: HomeCard[]; more: number } {
	const picked: HomeCard[] = [];
	for (const pane of panes) {
		if (pane.completed && !alive.has(pane.id)) continue;
		const column = boardColumn(
			pane.status ?? "idle",
			alive.has(pane.id),
			pane.odinParked ?? false,
			false,
			pane.odinClosedIn,
		);
		if (column === "permission" || column === "working")
			picked.push({ pane, column });
	}
	picked.sort(
		(a, b) =>
			Number(b.column === "permission") - Number(a.column === "permission") ||
			(b.pane.odinStatusAt ?? 0) - (a.pane.odinStatusAt ?? 0),
	);
	return {
		cards: picked.slice(0, HOME_LIMIT),
		more: Math.max(0, picked.length - HOME_LIMIT),
	};
}

/** 1 fills the page, 2 sit side by side, 3-4 make a 2x2, 5-6 a 3x2. */
export function homeGrid(count: number): { cols: number; rows: number } {
	if (count <= 1) return { cols: 1, rows: 1 };
	if (count === 2) return { cols: 2, rows: 1 };
	if (count <= 4) return { cols: 2, rows: 2 };
	return { cols: 3, rows: 2 };
}
