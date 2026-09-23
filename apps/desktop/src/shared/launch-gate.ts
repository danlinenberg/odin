import {
	type LaunchLimits,
	type MachineLoadInput,
	machineLoad,
} from "./machine-load";
import { isOdinCwd } from "./odin-tags";
import type { Pane } from "./tabs-types";

/**
 * Statuses that mean an agent is live in its checkout: running, or stopped
 * mid-run waiting for you to approve something. Both still own the tree.
 * `review` and `idle` don't — the agent has stopped, and holding a launch
 * until the board is tidy would mean holding it until you tidy the board.
 */
const OWNS_ITS_CHECKOUT = new Set(["working", "permission"]);

/**
 * One path inside the other — the same checkout. Odin's `.worktrees/` lives
 * inside it, and a launch into `repo/apps/x` still edits `repo`.
 * ponytail: nesting by path, not by git root — a session launched in a plain
 * parent folder (`~/dev`) holds every repo under it. Resolve roots if that bites.
 */
function sameCheckout(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Where a session was launched. `odinCwd` first: opening a terminal clears
 * `initialCwd`, and a pane running claude directly never reports a `cwd`, so an
 * opened session has neither. The launch cwd, not `pane.cwd`, is the checkout
 * — an agent that cds into /tmp mid-run still holds the tree it started in.
 * #odin covers Odin sessions from before `odinCwd` existed.
 */
function launchCwd(pane: Pane, odinRepoPath: string | null | undefined) {
	return (
		pane.odinCwd ??
		pane.initialCwd ??
		(pane.odinTags?.includes("odin") ? odinRepoPath : null) ??
		pane.cwd ??
		""
	);
}

/**
 * The session already working in the checkout `cwd` is in, if there is one.
 *
 * Two agents in one checkout edit each other's files, and each one's
 * `git status` is the other one's mess. One at a time, then — in every repo.
 */
export function sessionInFlight(
	panes: Pane[],
	cwd: string,
	odinRepoPath: string | null | undefined,
): { paneId: string; title: string } | null {
	if (!cwd) return null;
	const held = panes.find((pane) => {
		if (pane.completed || !OWNS_ITS_CHECKOUT.has(pane.status ?? ""))
			return false;
		const theirs = launchCwd(pane, odinRepoPath);
		return !!theirs && sameCheckout(theirs, cwd);
	});
	return held
		? { paneId: held.id, title: held.odinTaskTitle ?? held.name }
		: null;
}

/** "Odin's checkout" for Odin, the folder name for everything else. */
function checkoutName(cwd: string, odinRepoPath: string | null | undefined) {
	return isOdinCwd(cwd, odinRepoPath)
		? "Odin's checkout"
		: `the ${cwd.split("/").filter(Boolean).pop() ?? cwd} checkout`;
}

/**
 * Is it safe to start another agent right now, and if not, why not.
 *
 * Two gates, one answer: the Mac has to have room, and a checkout takes one
 * agent at a time (two agents in one tree hand each other a dirty tree).
 *
 * Neither gate refuses a launch — the card is created either way and waits in
 * Idle under "Queued" until this returns null. Blocking the launch instead
 * meant the task you asked for existed nowhere until it started.
 */
export function launchBlocker(
	snapshot: MachineLoadInput,
	panes: Pane[],
	cwd: string,
	odinRepoPath: string | null | undefined,
	limits?: LaunchLimits,
): string | null {
	const load = machineLoad(snapshot, limits);
	if (load.busy) return load.reason;
	const held = sessionInFlight(panes, cwd, odinRepoPath);
	return held
		? `waiting for "${held.title}" to finish in ${checkoutName(cwd, odinRepoPath)}`
		: null;
}
