import { useEffect, useRef } from "react";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { cronMatches, parseCron } from "shared/cron";
import { BUILTIN_AUTOMATIONS } from "./builtin-automations";
import { useOdinProfile } from "./useOdinProfile";
import {
	type OdinTask,
	taskPrompt,
	useMyTasks,
	useOdinTasks,
} from "./useOdinTasks";
import { useOdinWorkspace } from "./useOdinWorkspace";

/** How often the clock is read. Twice a minute, so no minute is missed. */
const TICK_MS = 30_000;

/**
 * Which automations are due right now.
 *
 * `lastRunAt` is the whole dedupe: a minute gets visited by two ticks, and
 * this is what stops the second one starting the job again. Split out from
 * the hook so the rule is testable without a renderer.
 *
 * The schedule is the only say in it — a due run starts even if the last
 * one's session is still open on the board. Pause is how you stop it; the
 * machine-capacity gate in `launch` is what keeps a fast cron from flattening
 * the Mac.
 *
 * ponytail: no catch-up. An automation that came due while the app was shut
 * is skipped, not run at launch — opening Odin on Monday morning should not
 * fire the weekend's three missed runs at once.
 */
export function dueAutomations(tasks: OdinTask[], now: Date): OdinTask[] {
	const minute = new Date(now).setSeconds(0, 0);
	return tasks.filter((task) => {
		if (!task.cron || task.paused) return false;
		if ((task.lastRunAt ?? 0) >= minute) return false;
		const cron = parseCron(task.cron);
		return !!cron && cronMatches(cron, now);
	});
}

/**
 * The clock behind the Automations panel. Mounted once in the Odin shell, so
 * it ticks on whichever view you're looking at.
 *
 * ponytail: the renderer, not the main process. Launching a session is a
 * renderer call (workspace, prompt file, pane, tab) and a schedule that only
 * runs while Odin is open is the honest description of a desktop app anyway.
 * Move it to main the day automations have to fire with the window shut.
 */
export function useAutomationRunner() {
	const { automations, markRun, setPane } = useMyTasks();
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch } = useLaunchTaskSession();
	const { activeId, isLoading } = useOdinProfile();

	// Odin's own automations, put on the list the first time this profile is
	// seen — including profiles that existed before there were any. Waiting for
	// the profile matters: seeding under "default" and then learning the real id
	// installs them twice, once in each list.
	useEffect(() => {
		if (!isLoading)
			useOdinTasks.getState().installBuiltins(activeId, BUILTIN_AUTOMATIONS);
	}, [activeId, isLoading]);

	// The interval is built once; everything it needs is read off this ref at
	// fire time. Rebuilding it on every store change would reset the clock.
	const latest = useRef({
		automations,
		markRun,
		setPane,
		ensureWorkspace,
		launch,
	});
	latest.current = {
		automations,
		markRun,
		setPane,
		ensureWorkspace,
		launch,
	};

	useEffect(() => {
		let running = false;
		const tick = async () => {
			// One launch at a time: `launch` waits on machine capacity, and two
			// overlapping ticks would both be holding for the same free memory.
			if (running) return;
			const now = new Date();
			const due = dueAutomations(latest.current.automations, now);
			if (due.length === 0) return;
			const minute = new Date(now).setSeconds(0, 0);
			running = true;
			try {
				for (const task of due) {
					// Stamped before the launch, not after: a launch that throws, or
					// that sits waiting for a busy Mac, must not leave the job due on
					// the next tick as well.
					latest.current.markRun(task.id, minute);
					const ensured = await latest.current.ensureWorkspace();
					if (!ensured.ok) continue;
					const result = await latest.current.launch({
						key: task.id,
						workspaceId: ensured.workspace.id,
						title: task.title,
						description: task.notes || null,
						brief: taskPrompt(task),
						// #automation on the card, so a session you didn't start
						// reads as one at a glance on the board.
						tags: ["automation"],
						skill: task.skill,
					});
					if (result.ok) latest.current.setPane(task.id, result.paneId);
				}
			} finally {
				running = false;
			}
		};
		const id = setInterval(() => void tick(), TICK_MS);
		return () => clearInterval(id);
	}, []);
}
