import type { PaneStatus } from "shared/tabs-types";

/**
 * The one place a pane status gets a colour and a name. The board's columns
 * and cards and the All feed's chips all draw the same states, and while each
 * kept its own literals they drifted - Working read green on one page and blue
 * on the other, and Done read blue in its header above a green card. The
 * drawer printed the raw enum, so a blocked card said "Permission". Exhaustive
 * over PaneStatus so a new status can't quietly inherit someone's default.
 *
 * The values are the semantic tokens in globals.css, so a `style` and a
 * Tailwind class name the same colour.
 */
export const PANE_STATUS: Record<PaneStatus, { dot: string; label: string }> = {
	// Blue is "in flight" - green is reserved for the finished state, because
	// green-as-running made a board of working cards read as a board of done.
	working: { dot: "var(--working)", label: "Working" },
	// "permission" is the hook event (PermissionRequest), not a word for people:
	// the session is blocked on a prompt or a question.
	permission: { dot: "var(--attention)", label: "Needs you" },
	review: { dot: "var(--success)", label: "Done" },
	// Idle is grey: nothing is running and nothing is wrong. Red is kept for
	// a failure, so a parked column no longer reads as a column of errors.
	idle: { dot: "var(--faint-foreground)", label: "Idle" },
	failed: { dot: "var(--danger)", label: "Failed" },
};
