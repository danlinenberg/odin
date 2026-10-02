import type { PaneStatus } from "shared/tabs-types";

/**
 * The one place a pane status gets a colour. The board's columns and cards and
 * the All feed's chips all draw the same states, and while each kept its own
 * literals they drifted — Working read green on one page and blue on the
 * other, and Done read blue in its header above a green card. Exhaustive over
 * PaneStatus so a new status can't quietly inherit someone's default.
 *
 * The values are the semantic tokens in globals.css, so a `style` and a
 * Tailwind class name the same colour.
 */
export const PANE_STATUS: Record<PaneStatus, { dot: string }> = {
	// Blue is "in flight" — green is reserved for the finished state, because
	// green-as-running made a board of working cards read as a board of done.
	working: { dot: "var(--working)" },
	permission: { dot: "var(--attention)" },
	review: { dot: "var(--success)" },
	// Idle is grey: nothing is running and nothing is wrong. Red is kept for
	// a failure, so a parked column no longer reads as a column of errors.
	idle: { dot: "var(--faint-foreground)" },
	failed: { dot: "var(--danger)" },
};
