import type { PaneStatus } from "renderer/stores/tabs/types";

/** What a bulk action reads off a ticked row: its column, and whether it ever started. */
export interface PickedCard {
	status: PaneStatus;
	pane: { id: string; odinQueued?: unknown };
}

/**
 * The ticked rows a bulk Resume brings back: sessions with no Claude in them
 * (the Idle column with the PTY gone) and ones never started (queued). A live
 * session is left alone - Resume kills and respawns it, and a working one
 * would lose its turn. Same rule as the card's own Resume button.
 */
export function resumable<T extends PickedCard>(
	cards: readonly T[],
	live: ReadonlySet<string>,
): T[] {
	return cards.filter(
		(card) =>
			!!card.pane.odinQueued ||
			(card.status === "idle" && !live.has(card.pane.id)),
	);
}

/** The ticked rows Move to Idle parks: the ones not already there. */
export function parkable<T extends PickedCard>(cards: readonly T[]): T[] {
	return cards.filter((card) => card.status !== "idle");
}
