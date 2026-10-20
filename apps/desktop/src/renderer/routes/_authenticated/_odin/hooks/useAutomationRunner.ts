import { useEffect, useRef } from "react";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { runsLocalSchedulers } from "renderer/lib/remote-core-link";
import { useTabsStore } from "renderer/stores/tabs/store";
import { automationRun, dueAutomations } from "shared/odin-tasks";
import { BUILTIN_AUTOMATIONS } from "./builtin-automations";
import { useOdinProfile } from "./useOdinProfile";
import { useMyTasks, useOdinTasks } from "./useOdinTasks";
import { useOdinWorkspace } from "./useOdinWorkspace";

export {
	automationRun,
	dueAutomations,
	taggedSessions,
} from "shared/odin-tasks";

/** How often the clock is read. Twice a minute, so no minute is missed. */
const TICK_MS = 30_000;

/**
 * The clock behind the Automations panel. Mounted once in the Odin shell, so
 * it ticks on whichever view you're looking at.
 *
 * On a remote server the server fires them instead (main/odin-core/scheduler.ts),
 * so they run with the laptop shut; this one stands down.
 */
export function useAutomationRunner() {
	const { automations, markRun, setPane } = useMyTasks();
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch } = useLaunchTaskSession();
	const { activeId, isLoading } = useOdinProfile();

	// Odin's own automations, put on the list the first time this profile is
	// seen - including profiles that existed before there were any. Waiting for
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
			// Sessions run on a server: its scheduler fires these, laptop or not.
			if (!runsLocalSchedulers()) return;
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
					const run = automationRun(task, useTabsStore.getState().panes);
					if (run === null) continue;
					const ensured = await latest.current.ensureWorkspace(null, {
						askForFolder: false,
					});
					if (!ensured.ok) continue;
					const result = await latest.current.launch({
						key: task.id,
						workspaceId: ensured.workspace.id,
						title: task.title,
						...run,
						// #automation on the card, so a session you didn't start
						// reads as one at a glance on the board.
						tags: ["automation"],
						skill: task.skill,
						repoPath: task.repo,
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
