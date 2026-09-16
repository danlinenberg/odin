import type { PaneStatus } from "shared/tabs-types";

/**
 * The one place a pane status gets a colour. The board's columns and the All
 * feed's chips both draw the same four states, and while each kept its own
 * literals they drifted — Working read green on one page and blue on the
 * other, and Done read blue in its header above a green card. Exhaustive over
 * PaneStatus so a new status can't quietly inherit someone's default.
 *
 * ponytail: a hex per status, not a theme. Statuses are the only thing on
 * these pages with a shared palette; promote it when a third page needs one.
 */
export const PANE_STATUS_DOT: Record<PaneStatus, string> = {
	// Blue is "in flight" — green is reserved for the finished state, because
	// green-as-running made a board of working cards read as a board of done.
	working: "#5aa9ff",
	permission: "#f5b83d",
	review: "#3ecf8e",
	idle: "#f0647a",
	// Failures live in the Needs you column and keep their red edge there.
	failed: "#f0647a",
};
