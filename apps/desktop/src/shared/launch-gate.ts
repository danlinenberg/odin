import { isOdinCwd, odinSessionInFlight } from "./odin-tags";
import type { Pane } from "./tabs-types";

/**
 * Is it safe to start another agent right now, and if not, why not.
 *
 * One gate: Odin's own checkout takes one agent at a time (work on Odin happens
 * in the checkout itself, so two agents in there hand each other a dirty tree).
 *
 * There used to be a CPU gate too. It held launches until the Mac had
 * headroom, which on a Mac that already felt slow only added waiting on top.
 *
 * The gate never refuses a launch — the card is created either way and waits in
 * Idle under "Queued" until this returns null. Blocking the launch instead
 * meant the task you asked for existed nowhere until it started.
 */
export function launchBlocker(
	panes: Pane[],
	cwd: string,
	odinRepoPath: string | null | undefined,
): string | null {
	if (!isOdinCwd(cwd, odinRepoPath)) return null;
	const held = odinSessionInFlight(panes, odinRepoPath);
	return held
		? `waiting for "${held.title}" to finish in Odin's checkout`
		: null;
}
