/**
 * Start each task that has no open session yet, one after another, and ask
 * `running` again right before each launch. A check made once for the whole
 * list went stale while the launches ran: Auto-start (Settings > Remote)
 * started some of the same tasks meanwhile, and each got a second session.
 * `running` must read the live board, not a copy taken before the loop.
 * Answers the tasks it launched.
 */
export async function launchUnstarted<T>(
	tasks: T[],
	running: (task: T) => boolean,
	launch: (task: T) => Promise<unknown>,
): Promise<T[]> {
	const launched: T[] = [];
	for (const task of tasks) {
		if (running(task)) continue;
		launched.push(task);
		await launch(task);
	}
	return launched;
}
