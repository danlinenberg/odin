import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Plenty for the sessions you'd come back to; the oldest pane drops first. */
const KEEP = 50;

interface Dismissed {
	paneId: string;
	items: string[];
	/** Dismissed since Claude was last told; rides on your next message. */
	untold: string[];
}

/**
 * Action items you closed with their X, by pane: the card hides them in every
 * later reply, and your next message tells Claude to stop listing them.
 */
export const useDismissedActions = create<{
	panes: Dismissed[];
	dismiss: (paneId: string, item: string) => void;
	/** The untold items, now marked told. */
	takeUntold: (paneId: string) => string[];
}>()(
	persist(
		(set, get) => {
			const update = (paneId: string, change: (pane: Dismissed) => Dismissed) =>
				set(({ panes }) => {
					const pane = panes.find((p) => p.paneId === paneId) ?? {
						paneId,
						items: [],
						untold: [],
					};
					const rest = panes.filter((p) => p.paneId !== paneId);
					return { panes: [...rest.slice(-(KEEP - 1)), change(pane)] };
				});
			return {
				panes: [],
				dismiss: (paneId, item) =>
					update(paneId, (pane) => ({
						...pane,
						items: [...pane.items, item],
						untold: [...pane.untold, item],
					})),
				takeUntold: (paneId) => {
					const untold =
						get().panes.find((p) => p.paneId === paneId)?.untold ?? [];
					if (untold.length)
						update(paneId, (pane) => ({ ...pane, untold: [] }));
					return untold;
				},
			};
		},
		{ name: "odin-dismissed-actions" },
	),
);

const words = (item: string) =>
	new Set(
		item
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // a link shows its words
			.replace(/\[[^\]]*\|[^\]]*\]/g, " ") // the choices change between replies
			.replace(/\(you only\)/gi, " ")
			.toLowerCase()
			.replace(/[^a-z0-9#/]+/g, " ")
			.split(" ")
			.filter(Boolean),
	);

/**
 * Whether `item` is one you dismissed, in the same or new words.
 */
export function isDismissed(dismissed: string[], item: string): boolean {
	const a = words(item);
	return dismissed.some((other) => {
		const b = words(other);
		const shared = [...a].filter((word) => b.has(word)).length;
		const all = new Set([...a, ...b]).size;
		return all > 0 && shared / all >= 0.6;
	});
}

/** `text` plus the items you dismissed since Claude was last told. */
export function withDismissals(paneId: string, text: string): string {
	const untold = useDismissedActions.getState().takeUntold(paneId);
	if (!untold.length) return text;
	const list = untold.map((item) => `- ${item}`).join("\n");
	return `${text}\n\n(I dismissed these action items - do not list them again:\n${list})`;
}
