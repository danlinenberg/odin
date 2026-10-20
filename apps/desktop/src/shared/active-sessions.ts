import { boardColumn } from "./board-column";
import { type BoardSection, boardSection } from "./board-section";
import { profileOf } from "./odin-profile";
import { boardTags } from "./odin-tags";
import type { Pane, PaneStatus } from "./tabs-types";

/**
 * Every session running right now, whichever feed started it - the answer the
 * per-source tabs can't give between them, since each one only knows about its
 * own rows (and a Slack row leaves the queue the moment its session starts).
 *
 * "Active" is the daemon's answer, not the pane's status: a session whose PTY
 * exited isn't running, whatever its card froze at.
 */
export interface ActiveSession {
	paneId: string;
	title: string;
	/** Which feed launched it - the board's own sections. */
	source: BoardSection;
	/** Where the board would file it: permission / working / review / idle. */
	column: PaneStatus;
	/** Who it's for - the person who asked. Absent on your own tasks. */
	contact: string | null;
	/** The board card's tags, same list. */
	tags: string[];
	/** Which repo it's running in - the cwd's last segment. */
	repo: string | null;
	/** Starred on the board (★): starred cards come first. */
	starred: boolean;
	/** When its status last changed - a turn that just ended reads as just done. */
	statusAt: number | null;
}

/** Needs-you first - the whole point of looking. */
const COLUMN_ORDER: PaneStatus[] = ["permission", "working", "review", "idle"];

export function activeSessions(
	panes: Record<string, Pane>,
	alive: Set<string>,
	/** null = every profile (the menu-bar tray has no profile picker). */
	profileId: string | null,
	/**
	 * The phone's board: sessions whose PTY ended too (not ones put away as
	 * Done), in Idle where the desktop board keeps them to resume.
	 */
	withEnded = false,
): ActiveSession[] {
	return Object.values(panes)
		.filter(
			(pane) =>
				pane.type === "terminal" &&
				// Same rule as the board: a terminal you opened yourself isn't a task.
				!!pane.odinTaskTitle &&
				(profileId === null || profileOf(pane.odinProfile) === profileId) &&
				(alive.has(pane.id) || (withEnded && !pane.completed)),
		)
		.map((pane) => ({
			paneId: pane.id,
			title: pane.odinTaskTitle ?? "",
			source: boardSection(pane),
			// An ended session can't be working: boardColumn says Idle, or Needs you if it asked you something.
			column: boardColumn(
				pane.status ?? "idle",
				alive.has(pane.id),
				pane.odinParked ?? false,
			),
			contact: pane.odinContact ?? null,
			tags: boardTags(pane.odinTags),
			// initialCwd too: a session whose terminal was never opened has no
			// confirmed cwd, same fallback the board's cards use.
			repo:
				(pane.cwd ?? pane.initialCwd)?.split("/").filter(Boolean).pop() ?? null,
			starred: !!pane.odinStarred,
			statusAt: pane.odinStatusAt ?? null,
		}))
		.sort(
			(a, b) =>
				COLUMN_ORDER.indexOf(a.column) - COLUMN_ORDER.indexOf(b.column) ||
				a.title.localeCompare(b.title),
		);
}
