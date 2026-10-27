import type { Pane } from "./tabs-types";

/**
 * A queued Resume, not a queued first launch: the session already has a
 * conversation, so Restart can reopen it. Read the same way the queue runner
 * reads it when it starts the pane.
 */
export function isQueuedResume(
	queued: NonNullable<Pane["odinQueued"]>,
): boolean {
	return queued.remote
		? queued.remote.claudeArgs.startsWith("--resume")
		: / --(resume|continue)\b/.test(queued.command);
}
