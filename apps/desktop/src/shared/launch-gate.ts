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
 * ponytail: nesting by path, not by git root — a repo launch aimed at a parent
 * folder holds every repo under it. Feed launches claim nothing (see
 * claimedCheckout), so only an explicit pick of that folder hits this.
 */
function sameCheckout(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * The checkout a launch claims while its agent works, or "" for none.
 *
 * A launch aimed at a repo claims it. A feed launch (Slack, Jira, PRs,
 * automations) runs in the workspace folder — a parent like `~/dev` that the
 * agent starts in, not the tree it edits — so it claims nothing: gating it
 * would queue every feed session behind every other one, and nesting would
 * lock every repo under that folder. Odin's own checkout is the exception, as
 * it always was.
 */
export function claimedCheckout(
	repoPath: string | undefined,
	worktreePath: string,
	odinRepoPath: string | null | undefined,
): string {
	// A resume passes the old cwd back as repoPath: the workspace folder is
	// still the workspace folder when it arrives that way.
	if (repoPath && repoPath !== worktreePath) return repoPath;
	return isOdinCwd(worktreePath, odinRepoPath) ? worktreePath : "";
}

/**
 * The checkout a session holds. `odinCwd` is stamped at launch and survives
 * opening a terminal, which clears `initialCwd`. Sessions from before it are
 * only known for Odin: the #odin tag, or a launch cwd inside Odin's checkout.
 * The launch cwd, not `pane.cwd`, is the checkout — an agent that cds into
 * /tmp mid-run still holds the tree it started in.
 */
function heldCheckout(pane: Pane, odinRepoPath: string | null | undefined) {
	if (pane.odinCwd) return pane.odinCwd;
	if (!odinRepoPath) return "";
	if (pane.odinTags?.includes("odin")) return odinRepoPath;
	const launched = pane.initialCwd ?? pane.cwd ?? "";
	return isOdinCwd(launched, odinRepoPath) ? launched : "";
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
		const theirs = heldCheckout(pane, odinRepoPath);
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
