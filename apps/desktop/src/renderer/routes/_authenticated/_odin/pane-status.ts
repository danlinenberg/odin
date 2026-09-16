import type { PaneStatus } from "shared/tabs-types";

/**
 * The one place a pane status gets a colour. The board's columns and cards and
 * the All feed's chips all draw the same states, and while each kept its own
 * literals they drifted — Working read green on one page and blue on the
 * other, and Done read blue in its header above a green card. Exhaustive over
 * PaneStatus so a new status can't quietly inherit someone's default.
 *
 * `tint` is Tailwind arbitrary-value classes rather than hexes because the
 * card keeps a hover border on top, and an inline border colour would outrank
 * the hover and kill it. globals.css points @source at every ts/tsx under
 * renderer/, so the classes are generated from this file.
 *
 * ponytail: a hex and two classes per status, not a theme. Statuses are the
 * only thing on these pages with a shared palette; promote it when a third
 * page needs one.
 */
export const PANE_STATUS: Record<PaneStatus, { dot: string; tint: string }> = {
	// Blue is "in flight" — green is reserved for the finished state, because
	// green-as-running made a board of working cards read as a board of done.
	working: { dot: "#5aa9ff", tint: "border-[#26476b] bg-[#111a24]" },
	permission: { dot: "#f5b83d", tint: "border-[#6b5620] bg-[#221d12]" },
	review: { dot: "#3ecf8e", tint: "border-[#265c41] bg-[#112419]" },
	// Idle takes a dimmer red than failed: same "nothing is running" family,
	// but a failure sitting in the Needs you column should still read hotter
	// than a session that's merely parked.
	idle: { dot: "#f0647a", tint: "border-[#4a2029] bg-[#191114]" },
	failed: { dot: "#f0647a", tint: "border-[#5a2733] bg-[#1d1417]" },
};
