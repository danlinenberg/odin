import type { Pane } from "./tabs-types";

/**
 * Does this session run inside Odin's own checkout? Worktrees under it count:
 * they are the same repo, and `.worktrees/` lives inside the checkout.
 */
export function isOdinCwd(
	cwd: string,
	odinRepoPath: string | null | undefined,
): boolean {
	return (
		!!odinRepoPath &&
		(cwd === odinRepoPath || cwd.startsWith(`${odinRepoPath}/`))
	);
}

/**
 * #odin for any session running inside Odin's own checkout, whichever view
 * launched it. The rail's "Work on Odin" passes the tag explicitly, but the
 * board's New Session repo picker doesn't — deriving it from the session cwd
 * covers every entry point, worktrees included.
 */
export function withOdinTag(
	tags: string[] | undefined,
	cwd: string,
	odinRepoPath: string | null | undefined,
): string[] | undefined {
	const inOdin = isOdinCwd(cwd, odinRepoPath);
	if (!inOdin) return tags;
	return tags?.includes("odin") ? tags : [...(tags ?? []), "odin"];
}

/**
 * Every tag a card can carry, and the only ones it may. Deliberately short:
 * with a dozen of them each pill matched two cards and the filter bar was
 * longer than the columns. #odin is derived from the cwd (above), the rest are
 * picked by the brief writer or by hand.
 */
export const TAG_VOCABULARY = [
	// Stamped by the automation runner, so a card that appeared while you were
	// away says why it's there. Also pickable by hand.
	"automation",
	"bug",
	"feature",
	"chore",
	"docs",
	"infra",
] as const;

/** The full board set — what the tag menu offers. */
export const BOARD_TAGS: string[] = ["odin", ...TAG_VOCABULARY];

/**
 * Drop anything off the list. Sessions tagged under the old, longer vocabulary
 * keep #perf/#ui/#api/… in app-state; this is where they stop being shown,
 * rather than a migration over persisted state.
 */
export function boardTags(tags: string[] | undefined): string[] {
	return (tags ?? []).filter((tag) => BOARD_TAGS.includes(tag));
}

/**
 * Statuses that mean an agent is live in its checkout: running, or stopped
 * mid-run waiting for you to approve something. Both still own the tree.
 * `review` and `idle` don't — the agent has stopped, and holding a launch
 * until the board is tidy would mean holding it until you tidy the board.
 */
const OWNS_ITS_CHECKOUT = new Set(["working", "permission"]);

/**
 * The session already working in Odin's own checkout, if there is one.
 *
 * Odin is worked on in place — sessions run in the checkout itself, not in a
 * worktree each — so two agents in there at once edit each other's files, and
 * each one's `git status` is the other one's mess. One at a time, then.
 *
 * ponytail: the launch cwd identifies the checkout, not `pane.cwd` — an agent
 * that cds into /tmp mid-run is still holding the tree it started in.
 */
export function odinSessionInFlight(
	panes: Pane[],
	odinRepoPath: string | null | undefined,
): { paneId: string; title: string } | null {
	const held = panes.find(
		(pane) =>
			!pane.completed &&
			OWNS_ITS_CHECKOUT.has(pane.status ?? "") &&
			isOdinCwd(pane.initialCwd ?? pane.cwd ?? "", odinRepoPath),
	);
	return held
		? { paneId: held.id, title: held.odinTaskTitle ?? held.name }
		: null;
}
