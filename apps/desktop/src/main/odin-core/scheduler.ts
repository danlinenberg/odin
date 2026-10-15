import { activeProfileId } from "lib/trpc/routers/odin-config";
import {
	DEFAULT_OFF_HOURS,
	inOffHours,
	nightInstructions,
	type OffHours,
} from "shared/night-agent";
import { profileOf } from "shared/odin-profile";
import {
	automationRun,
	dueAutomations,
	type OdinTask,
} from "shared/odin-tasks";
import {
	EMPTY_SERVER_NIGHT,
	NIGHT_QUEUE_KEY,
	type NightQueue,
	type NightQueueRow,
	SERVER_NIGHT_KEY,
	SERVER_RUNS_KEY,
	SERVER_SLACK_KEY,
	type ServerNight,
} from "shared/server-board";
import { buildThreadPrompt } from "shared/thread-prompt";
import {
	boardView,
	drainQueue,
	readCards,
	type ServerLaunchInput,
	serverLaunch,
} from "./launcher";
import { sampleCpu } from "./machine";
import { readJsonState, readStoreState, writeJsonState } from "./state-store";

/**
 * The schedulers that start sessions, run on the server so they keep going
 * with the laptop shut: automations, the Slack auto-launcher, the launch queue
 * and the Night Agent. In remote mode the window's own copies stand down
 * (they check `isRemoteCoreMode`), so nothing starts twice.
 *
 * They read what the window mirrored (state-mirror.ts) and keep their own
 * bookkeeping under `server:` keys.
 */

/** The Odin core router's calls the schedulers make. */
export interface SchedulerCore {
	slackReactions(): Promise<{
		rows: {
			id: string;
			title: string;
			text: string;
			permalink: string | null;
			authorName?: string | null;
			autoLaunch?: boolean;
		}[];
	}>;
	markSlackStarted(id: string): Promise<unknown>;
	rankNextInLine(input: {
		items: NightQueueRow["rank"][];
		instructions: string;
	}): Promise<{ keys: string[]; hidden: string[] }>;
	/** External ids of every item a session was ever started on. */
	startedKeys(): Promise<Set<string>>;
}

const AUTOMATION_TICK_MS = 30_000;
const QUEUE_TICK_MS = 15_000;
const SLACK_TICK_MS = 2 * 60_000;
const NIGHT_TICK_MS = 60_000;
/** Night ticks this far apart mean the runner wasn't running in between. */
const NIGHT_GAP_MS = 5 * NIGHT_TICK_MS;
const MAX_NIGHT_LOG = 300;
const MAX_SLACK_TRIED = 500;

function log(message: string, error?: unknown): void {
	console.warn(`[odin-core] ${message}`, error ?? "");
}

/** One tick of each at a time: a slow launch must not overlap the next tick. */
function every(ms: number, name: string, tick: () => Promise<void>): void {
	let running = false;
	setInterval(() => {
		if (running) return;
		running = true;
		tick()
			.catch((error) => log(`${name} tick failed:`, error))
			.finally(() => {
				running = false;
			});
	}, ms).unref();
}

// ---- automations ----

export async function automationTick(now = new Date()): Promise<void> {
	const tasks = readStoreState<{ tasks?: OdinTask[] }>("odin-tasks")?.tasks;
	if (!tasks?.length) return;
	const runs = readJsonState<Record<string, number>>(SERVER_RUNS_KEY, {});
	const profile = activeProfileId();
	// The window's lastRunAt and the server's own: either one ran it.
	const mine = tasks
		.filter((task) => profileOf(task.profileId) === profile)
		.map((task) => ({
			...task,
			lastRunAt: Math.max(task.lastRunAt ?? 0, runs[task.id] ?? 0),
		}));
	const due = dueAutomations(mine, now);
	if (!due.length) return;
	const minute = new Date(now).setSeconds(0, 0);
	// Stamped before the launch: one that throws must not be due again next tick.
	writeJsonState(SERVER_RUNS_KEY, {
		...runs,
		...Object.fromEntries(due.map((task) => [task.id, minute])),
	});
	const { panes } = await boardView();
	const byId = Object.fromEntries(panes.map((pane) => [pane.id, pane]));
	for (const task of due) {
		const run = automationRun(task, byId);
		if (run === null) continue;
		await serverLaunch({
			key: task.id,
			title: task.title,
			...run,
			tags: ["automation"],
			skill: task.skill,
			repoPath: task.repo,
			origin: "automation",
			taskId: task.id,
		}).catch((error) => log(`automation "${task.title}" failed:`, error));
	}
}

// ---- Slack: the launch reaction ----

type SlackRow = Awaited<
	ReturnType<SchedulerCore["slackReactions"]>
>["rows"][number];

/** Rows carrying the launch reaction that haven't been tried yet. */
export function slackRowsToStart(
	rows: SlackRow[],
	tried: string[],
): SlackRow[] {
	return rows.filter((row) => row.autoLaunch && !tried.includes(row.id));
}

/**
 * What a Slack row starts with - the window's auto-start (useStartReaction)
 * exactly. Null when there's no link to hand the session.
 */
export function slackLaunchInput(row: SlackRow): ServerLaunchInput | null {
	if (!row.permalink) return null;
	return {
		key: row.id,
		title: row.title,
		description: buildThreadPrompt(row.permalink, row.title, row.text),
		contact: row.authorName ?? null,
		// The whole message: the title is cut at 120 chars.
		brief: row.text || row.title,
		pageId: row.id,
		source: "reactions",
		tags: ["auto-started"],
		origin: "slack",
		slackRowId: row.id,
	};
}

export async function slackTick(core: SchedulerCore): Promise<void> {
	const { rows } = await core.slackReactions();
	const tried = readJsonState<string[]>(SERVER_SLACK_KEY, []);
	for (const row of slackRowsToStart(rows, tried)) {
		// Once per row, ever: a failed launch isn't retried every poll.
		tried.push(row.id);
		writeJsonState(SERVER_SLACK_KEY, tried.slice(-MAX_SLACK_TRIED));
		const input = slackLaunchInput(row);
		if (!input) continue;
		try {
			await serverLaunch(input);
			await core.markSlackStarted(row.id);
		} catch (error) {
			log(`Slack auto-launch "${row.title}" failed:`, error);
		}
	}
}

// ---- Night Agent ----

function readNight(): ServerNight {
	return { ...EMPTY_SERVER_NIGHT, ...readJsonState(SERVER_NIGHT_KEY, {}) };
}

/**
 * The Night Agent, as the window runs it (useNightAgentRunner): inside the
 * window set in Settings → Backlog, start the top of Next in line, wait for it
 * to stop working, start the next - until the window closes or the night's
 * ceiling is hit. The queue is Next in line as the window last built it.
 */
export async function nightTick(
	core: SchedulerCore,
	now = new Date(),
): Promise<void> {
	const prefs = readStoreState<{
		prompt?: string;
		offHours?: Partial<OffHours>;
	}>("odin-next-in-line-prompt");
	const offHours: OffHours = { ...DEFAULT_OFF_HOURS, ...prefs?.offHours };
	const night = readNight();
	const save = () => writeJsonState(SERVER_NIGHT_KEY, night);
	const say = (event: string) => {
		if (night.log.at(-1)?.event === event) return;
		night.log = [...night.log, { at: now.toISOString(), event }].slice(
			-MAX_NIGHT_LOG,
		);
	};
	try {
		const inWindow = inOffHours(now, offHours.start, offHours.end);
		const span = `${offHours.start}-${offHours.end}`;
		if (inWindow) {
			const last = night.lastTick ? new Date(night.lastTick) : null;
			if (last && now.getTime() - last.getTime() > NIGHT_GAP_MS)
				say(
					`No ticks from ${last.toLocaleString()} to ${now.toLocaleString()}: the server's Odin was not running.`,
				);
			night.lastTick = now.toISOString();
		}
		if (!offHours.enabled) {
			if (inWindow)
				say(`Off in Settings, so the ${span} window starts nothing.`);
			return;
		}
		if (!inWindow) {
			if (night.ranking || night.started)
				say(
					`Window ${span} closed: ${night.started} of at most ${offHours.maxSessions} started.`,
				);
			night.started = 0;
			night.fromPicks = false;
			night.tried = [];
			night.ranking = null;
			return;
		}
		if (night.started >= offHours.maxSessions)
			return say(`Reached tonight's cap of ${offHours.maxSessions} sessions.`);
		const { panes, live } = await boardView();
		const busy = panes.find(
			(pane) =>
				!pane.completed &&
				pane.odinTags?.includes("off-hours") &&
				(live.get(pane.id) === "working" || !!pane.odinQueued),
		);
		if (busy)
			return say(
				`Waiting for "${busy.odinTaskTitle ?? busy.name}" to stop working.`,
			);

		const queue = readJsonState<NightQueue>(NIGHT_QUEUE_KEY, {
			rows: [],
			prompt: "",
		});
		const started = await core.startedKeys();
		for (const card of readCards()) {
			if (card.key) started.add(card.key);
			if (card.taskId) started.add(card.taskId);
		}
		const waiting = queue.rows.filter(
			(row) => !started.has(row.launch.key) && !night.tried.includes(row.key),
		);
		const start = async (row: NightQueueRow) => {
			night.tried.push(row.key);
			night.started += 1;
			save();
			await launchNightRow(core, row, offHours.instructions);
		};

		const picksLeft = offHours.picked.filter(
			(key) => !night.picksStarted.includes(key),
		);
		if (picksLeft.length) {
			const byKey = new Map(waiting.map((row) => [row.key, row]));
			const pick = picksLeft
				.map((key) => byKey.get(key))
				.find((row) => row && !row.duplicate);
			if (pick) {
				say(`Started your pick "${pick.title}" (${pick.source}).`);
				night.picksStarted = [...night.picksStarted, pick.key].slice(-100);
				night.fromPicks = true;
				return await start(pick);
			}
		}
		if ((picksLeft.length || night.fromPicks) && offHours.afterPicks === "stop")
			return say(
				'Picks all started, and "after picks" is set to stop: starting nothing more.',
			);

		const instructions = nightInstructions(queue.prompt, offHours.instructions);
		const stale =
			night.ranking?.instructions !== instructions ||
			waiting.some((row) => !night.ranking?.seen.includes(row.key));
		if (stale) {
			// A failed ranking starts nothing: without it, nothing says which
			// rows your instructions rule out.
			const ranking = await core.rankNextInLine({
				items: waiting.map((row) => row.rank),
				instructions,
			});
			night.ranking = {
				instructions,
				seen: waiting.map((row) => row.key),
				order: ranking.keys,
				hidden: ranking.hidden,
			};
			const ruledOut = waiting
				.filter((row) => ranking.hidden.includes(row.key))
				.map((row) => `"${row.title}"`);
			say(
				`Ranked ${waiting.length} waiting rows; your instructions ruled out ${ruledOut.length}${ruledOut.length ? `: ${ruledOut.join(", ")}` : ""}.`,
			);
		}
		const order: string[] = night.ranking?.order ?? [];
		const hidden: string[] = night.ranking?.hidden ?? [];
		const rank = (key: string) => {
			const at = order.indexOf(key);
			return at === -1 ? order.length : at;
		};
		const pinned = waiting.filter((row) => row.pinned);
		const unpinned = waiting
			.filter((row) => !row.pinned)
			.toSorted((a, b) => rank(a.key) - rank(b.key));
		const item = [...pinned, ...unpinned].find(
			(row) => !hidden.includes(row.key) && !row.duplicate,
		);
		if (!item)
			return say(
				`Nothing left to start: ${waiting.length} waiting, ${hidden.length} ruled out, ${night.tried.length} already tried, the rest marked duplicates.`,
			);
		say(`Started "${item.title}" (${item.source}), top of the ranking.`);
		await start(item);
	} catch (error) {
		say(
			`Ranking failed, so it started nothing: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		save();
	}
}

async function launchNightRow(
	core: SchedulerCore,
	row: NightQueueRow,
	instructions: string,
): Promise<void> {
	const { launch } = row;
	const input: ServerLaunchInput = {
		key: launch.key,
		title: launch.title,
		description:
			[launch.description, instructions].filter(Boolean).join("\n\n") || null,
		contact: launch.contact,
		brief: launch.brief,
		pageId: launch.pageId ?? null,
		...(launch.source ? { source: launch.source } : {}),
		skill: launch.skill,
		tags: ["off-hours"],
		origin: "night",
		...(row.source === "Tasks" ? { taskId: launch.key } : {}),
		...(row.source === "Slack" ? { slackRowId: launch.key } : {}),
	};
	await serverLaunch(input);
	if (row.source === "Slack") await core.markSlackStarted(launch.key);
}

/** Start every clock. Called once, when the Odin core mounts. */
export function startSchedulers(core: SchedulerCore): void {
	sampleCpu();
	every(15_000, "cpu", async () => sampleCpu());
	every(AUTOMATION_TICK_MS, "automations", () => automationTick());
	every(QUEUE_TICK_MS, "queue", () => drainQueue());
	every(SLACK_TICK_MS, "slack", () => slackTick(core));
	every(NIGHT_TICK_MS, "night", () => nightTick(core));
	console.log("[odin-core] schedulers running");
}
