import { useEffect, useRef } from "react";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useTabsStore } from "renderer/stores/tabs/store";
import { cronMatches, nextRun, parseCron } from "shared/cron";
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

/** How far ahead the host gets run times: the reach of what this computer sends it. */
const HOST_DAYS = 3;
/** The most run times one automation sends: three days of a 15-minute schedule. */
const HOST_RUNS = 300;
/** How often the host's list goes again while it is unchanged, so it never runs out. */
const HOST_RESEND_MS = 30 * 60_000;
/** How often the host is asked for runs it started; on every tick for a while after a wake. */
const HOST_ADOPT_EVERY_TICKS = 10;
const HOST_EAGER_TICKS = 10;
/** A run the host started longer ago than this isn't put on the board. */
const HOST_ADOPT_DAYS = 4;

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

/**
 * The automations the remote host runs while this computer is away: on a
 * schedule, not paused, not kept on this Mac, and watching no tags (those
 * read the board, which only this computer has).
 */
export function hostAutomations(tasks: OdinTask[]): OdinTask[] {
	return tasks.filter(
		(task) =>
			!!task.cron &&
			!task.paused &&
			!task.here &&
			!task.tags?.length &&
			!!parseCron(task.cron),
	);
}

/** An automation's run times from `from` (exclusive) for `days`, as epoch seconds. */
export function upcomingRuns(
	cron: string,
	from: Date,
	days = HOST_DAYS,
	cap = HOST_RUNS,
): number[] {
	const end = from.getTime() + days * 86_400_000;
	const out: number[] = [];
	let at = nextRun(cron, from);
	while (at && at.getTime() < end && out.length < cap) {
		out.push(at.getTime() / 1000);
		at = nextRun(cron, at);
	}
	return out;
}

/** The key a run goes by in the host's ledger (main/lib/remote-host/away scheduledRunKey). */
export const runKey = (id: string, minuteMs: number) =>
	`auto:${id}:${Math.floor(minuteMs / 1000)}`;

/**
 * A run the host started that the board should take in: its automation is
 * still here, it's newer than the last run this computer knows of, recent,
 * and not on the board already.
 */
export function adoptableRun(
	run: { schedule: string; slot: number; sessionId: string; at: number },
	tasks: OdinTask[],
	onBoard: Set<string>,
	now = Date.now(),
): OdinTask | null {
	const task = tasks.find((t) => t.id === run.schedule);
	if (!task) return null;
	if (run.slot * 1000 <= (task.lastRunAt ?? 0)) return null;
	if (run.at * 1000 < now - HOST_ADOPT_DAYS * 86_400_000) return null;
	if (onBoard.has(run.sessionId)) return null;
	return task;
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
 * With the window shut or the Mac asleep, the remote host fires them
 * instead (Tasks with the Mac closed, below).
 */
export function useAutomationRunner() {
	const { automations, markRun, setPane } = useMyTasks();
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, planForHost } = useLaunchTaskSession();
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
		planForHost,
	});
	latest.current = {
		automations,
		markRun,
		setPane,
		ensureWorkspace,
		launch,
		planForHost,
	};
	// The automations the host has a copy of: a run of one is taken on the
	// host before it starts here, so the host doesn't start it too.
	const onHost = useRef(new Set<string>());

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
					if (onHost.current.has(task.id) && !task.here) {
						const claimed = await electronTrpcClient.remoteHost.claimRun
							.mutate({ key: runKey(task.id, minute) })
							// The host can't be asked: start it here, as before.
							.catch(() => ({ taken: true }));
						if (!claimed.taken) continue;
					}
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
						...(task.here ? { onHost: false } : {}),
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

	// With Tasks with the Mac closed on, the host keeps a copy of the
	// automations and starts a run this computer didn't (asleep or shut);
	// when it's back, those runs come onto the board.
	useEffect(() => {
		let running = false;
		let ticks = 0;
		let eager = 0;
		let lastTick = Date.now();
		let sent: { signature: string; at: number } | null = null;
		const tick = async () => {
			if (Date.now() - lastTick > 3 * TICK_MS) eager = HOST_EAGER_TICKS;
			lastTick = Date.now();
			if (running) return;
			running = true;
			try {
				const host = (
					await electronTrpcClient.remoteHost.get.query().catch(() => null)
				)?.host;
				if (!host?.on || !host.awayTasks) {
					onHost.current = new Set();
					sent = null;
					return;
				}
				const { automations, markRun, setPane, ensureWorkspace, launch } =
					latest.current;
				if (ticks++ % HOST_ADOPT_EVERY_TICKS === 0 || eager-- > 0) {
					const { scheduled } =
						await electronTrpcClient.remoteHost.nightStarted.query();
					const onBoard = new Set<string>();
					for (const pane of Object.values(useTabsStore.getState().panes))
						if (pane.claudeSessionId) onBoard.add(pane.claudeSessionId);
					for (const run of scheduled) {
						const task = adoptableRun(run, automations, onBoard);
						if (!task) continue;
						const ensured = await ensureWorkspace(null, {
							askForFolder: false,
						});
						if (!ensured.ok) break;
						const plan = automationRun(task, {}) ?? {
							description: null,
							brief: task.title,
						};
						const result = await launch({
							key: task.id,
							workspaceId: ensured.workspace.id,
							title: task.title,
							...plan,
							tags: ["automation"],
							resumeSessionId: run.sessionId,
							onHost: true,
						});
						if (!result.ok) continue;
						markRun(task.id, run.slot * 1000);
						setPane(task.id, result.paneId);
						onBoard.add(run.sessionId);
					}
				}
				const list = hostAutomations(automations);
				const signature = JSON.stringify(
					list.map((t) => [t.id, t.cron, t.title, t.notes, t.skill, t.repo]),
				);
				if (
					sent?.signature === signature &&
					Date.now() - sent.at < HOST_RESEND_MS
				)
					return;
				const ensured = await ensureWorkspace(null, { askForFolder: false });
				if (!ensured.ok) return;
				const now = new Date();
				const schedules = [];
				for (const task of list) {
					const plan = automationRun(task, {});
					if (!plan) continue;
					const planned = await latest.current.planForHost({
						key: task.id,
						workspaceId: ensured.workspace.id,
						title: task.title,
						...plan,
						tags: ["automation"],
						skill: task.skill,
						repoPath: task.repo,
					});
					schedules.push({
						key: task.id,
						title: task.title,
						sessionId: planned.sessionId,
						repoPath: task.repo ?? null,
						prompt: planned.prompt,
						at: upcomingRuns(task.cron as string, now),
					});
				}
				await electronTrpcClient.remoteHost.schedulesPush.mutate({ schedules });
				onHost.current = new Set(schedules.map((s) => s.key));
				sent = { signature, at: Date.now() };
			} catch (error) {
				console.warn("[automations on host]", error);
			} finally {
				running = false;
			}
		};
		void tick();
		const id = setInterval(() => void tick(), 2 * TICK_MS);
		return () => clearInterval(id);
	}, []);
}
