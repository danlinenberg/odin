import { useEffect, useRef } from "react";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { useTabsStore } from "renderer/stores/tabs/store";
import { cronMatches, parseCron } from "shared/cron";
import type { Pane } from "shared/tabs-types";
import { BUILTIN_AUTOMATIONS } from "./builtin-automations";
import { useOdinProfile } from "./useOdinProfile";
import {
	type OdinTask,
	taskNotes,
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
 * The schedule is the only say in it - a due run starts even if the last
 * one's session is still open on the board. Pause is how you stop it; the
 * machine-capacity gate in `launch` is what keeps a fast cron from flattening
 * the Mac.
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

export function taggedSessions(
	panes: Record<string, Pane>,
	tags: readonly string[],
): Pane[] {
	return Object.values(panes).filter(
		(pane) =>
			pane.odinTaskTitle &&
			!pane.completed &&
			pane.odinTags?.some((tag) => tags.includes(tag)),
	);
}

/**
 * What a run launches with. Null = skip it: it watches tags and no open
 * session carries one. The tagged sessions ride in `description`, the text
 * the agent's prompt is built from - `brief` is only kept on the card.
 */
export function automationRun(
	task: OdinTask,
	panes: Record<string, Pane>,
): { description: string | null; brief: string } | null {
	const notes = taskNotes(task);
	if (!task.tags?.length)
		return { description: notes || null, brief: taskPrompt(task) };
	const sessions = taggedSessions(panes, task.tags);
	if (sessions.length === 0) return null;
	const description = [
		...(notes ? [notes, ""] : []),
		`Sessions on the board tagged ${task.tags.map((tag) => `#${tag}`).join(" or ")} (paneId is what Odin's local API takes):`,
		...sessions.map(
			(pane) =>
				`- ${pane.odinTaskTitle} - paneId ${pane.id}, status ${pane.status ?? "idle"}, tags ${(pane.odinTags ?? []).map((tag) => `#${tag}`).join(" ")}`,
		),
		"",
		// Without this the tag stays, and every tick runs the same session again.
		`When you finish with a session, drop ${task.tags.map((tag) => `#${tag}`).join(" / ")} from its tags so the next run skips it: curl -sf http://127.0.0.1:$ODIN_PORT/odin --data-urlencode action=set --data-urlencode store=sessions --data-urlencode 'patch={"panes":{"<paneId>":{"odinTags":[<its other tags>]}}}'`,
	].join("\n");
	return { description, brief: `${task.title}\n\n${description}` };
}

/**
 * The clock behind the Automations panel. Mounted once in the Odin shell, so
 * it ticks on whichever view you're looking at.
 *
 * Move it to main the day automations have to fire with the window shut.
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
