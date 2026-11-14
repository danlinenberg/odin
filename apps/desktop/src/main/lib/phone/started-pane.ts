import { TRPCError } from "@trpc/server";

/**
 * A started task's paneId, which the phone opens. A launch that failed is an
 * error the phone shows (`saved`: said first, for a task that was added), not
 * a form that closes on nothing. {} when the window answered in words:
 * nothing found to start.
 */
export function startedPane(text: string, saved = ""): { paneId?: string } {
	let answer: { paneId?: unknown; error?: unknown };
	try {
		answer = JSON.parse(text);
	} catch {
		return {};
	}
	if (typeof answer.error === "string")
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: saved + answer.error,
		});
	return typeof answer.paneId === "string" ? { paneId: answer.paneId } : {};
}

/**
 * The phone's Backlog: tasks no session was ever started on, as the desktop's
 * Next in line counts them. `started` alone is a session open now, so a task
 * whose session ended came back as waiting, weeks after it ran. A window from
 * before `ran` sends none: then `started` decides, as it did.
 */
export function waitingTasks<T extends { started: boolean; ran?: boolean }>(
	tasks: T[],
): T[] {
	return tasks.filter((task) => !task.started && !task.ran);
}
