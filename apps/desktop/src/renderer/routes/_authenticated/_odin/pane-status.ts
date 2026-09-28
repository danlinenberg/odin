import type { PaneStatus } from "shared/tabs-types";

/**
 * The one place a pane status gets a colour. The board's columns and cards and
 * the All feed's chips all draw the same states, and while each kept its own
 * literals they drifted — Working read green on one page and blue on the
 * other, and Done read blue in its header above a green card. Exhaustive over
 * PaneStatus so a new status can't quietly inherit someone's default.
 *
 * ponytail: a hex and two classes per status, not a theme. Statuses are the
 * only thing on these pages with a shared palette; promote it when a third
 * page needs one.
 */
export const PANE_STATUS: Record<PaneStatus, { dot: string }> = {
	// Blue is "in flight" — green is reserved for the finished state, because
	// green-as-running made a board of working cards read as a board of done.
	working: { dot: "#5aa9ff" },
	permission: { dot: "#f5b83d" },
	review: { dot: "#3ecf8e" },
	// Idle takes a dimmer red than failed: same "nothing is running" family,
	// but a failure sitting in the Needs you column should still read hotter
	// than a session that's merely parked.
	idle: { dot: "#f0647a" },
	failed: { dot: "#f0647a" },
};
