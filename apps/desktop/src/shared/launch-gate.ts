import { type MachineLoadInput, machineLoad } from "./machine-load";
import { isOdinCwd, odinSessionInFlight } from "./odin-tags";
import type { Pane } from "./tabs-types";

/**
 * Is it safe to start another agent right now, and if not, why not.
 *
 * Two gates, one answer: the Mac has to have room, and Odin's own checkout
 * takes one agent at a time (work on Odin happens in the checkout itself, so
 * two agents in there hand each other a dirty tree).
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
): string | null {
	const load = machineLoad(snapshot);
	if (load.busy) return load.reason;
	if (!isOdinCwd(cwd, odinRepoPath)) return null;
	const held = odinSessionInFlight(panes, odinRepoPath);
	return held
		? `waiting for "${held.title}" to finish in Odin's checkout`
		: null;
}
