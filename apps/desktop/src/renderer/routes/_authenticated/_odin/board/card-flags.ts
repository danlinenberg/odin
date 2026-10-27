import { create } from "zustand";

/**
 * What the board's cards say "Dropped" about, per paneId: its PR was merged
 * or closed. The board writes it as it reads PR states; the phone's board
 * reads it to show the same line. In memory only, rebuilt on every board read.
 */
export const useCardFlags = create<{
	dropped: Record<string, "PR merged" | "PR closed">;
}>(() => ({ dropped: {} }));

/** The dropped map from the board's two sets; merged wins, as on the card. */
export function droppedFlags(
	closed: Set<string>,
	merged: Set<string>,
): Record<string, "PR merged" | "PR closed"> {
	const flags: Record<string, "PR merged" | "PR closed"> = {};
	for (const id of closed) flags[id] = "PR closed";
	for (const id of merged) flags[id] = "PR merged";
	return flags;
}
