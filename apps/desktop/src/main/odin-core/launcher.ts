import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { activeProfileId } from "lib/trpc/routers/odin-config";
import {
	type ClaudeCommandSettings,
	claudeLaunchWith,
	DEFAULT_CLAUDE_COMMAND,
} from "shared/claude-launch";
import { claimedCheckout, launchBlocker } from "shared/launch-gate";
import { DEFAULT_LAUNCH_LIMITS, type LaunchLimits } from "shared/machine-load";
import { type OdinRule, rulesSettings } from "shared/odin-rules";
import {
	BOARD_PANES_KEY,
	type BoardPane,
	LAUNCH_CONTEXT_KEY,
	type LaunchContext,
	type PanePatches,
	SERVER_CARDS_KEY,
	SERVER_PANE_PATCHES_KEY,
	type ServerCard,
	statusFromAgentEvent,
} from "shared/server-board";
import {
	buildPrompt,
	DEFAULT_SESSION_INSTRUCTIONS,
	type OdinSource,
	quote,
	slugify,
} from "shared/session-launch";
import type { Pane } from "shared/tabs-types";
import { hostApi } from "./host-api";
import { machineSnapshot } from "./machine";
import {
	readJsonState,
	readStateEntry,
	readStoreState,
	writeJsonState,
} from "./state-store";

/**
 * Starting sessions on the server, for its schedulers: the same prompt file,
 * rules hook and Claude command the window builds (shared/session-launch,
 * shared/claude-launch), from the settings the window mirrored here. Each
 * session gets a card record (`server:cards`) the window adopts onto the board
 * when it next connects - the pane id is the session's id, so the card attaches
 * to the running session like any other.
 */

/** Cards older than this are only kept while their session could still matter. */
const MAX_CARDS = 300;
/** A started agent that hasn't reported yet still counts as working this long. */
const STARTING_GRACE_MS = 3 * 60_000;

/** The ledger and Slack calls a launch makes - the Odin core router's caller. */
export interface LaunchEffects {
	recordWork(input: {
		source: "reactions" | "jira" | "pr" | "notion";
		externalId: string;
		title: string;
		person: string | null;
		cwd: string;
		sessionId: string;
	}): Promise<unknown>;
}

let effects: LaunchEffects | null = null;

export function configureLauncher(next: LaunchEffects): void {
	effects = next;
}

export function launchContext(): LaunchContext | null {
	const context = readJsonState<LaunchContext | null>(LAUNCH_CONTEXT_KEY, null);
	return context?.workspacePath ? context : null;
}

export function readCards(): ServerCard[] {
	return readJsonState<ServerCard[]>(SERVER_CARDS_KEY, []);
}

/** Read-modify-write the cards. Single-threaded, so nothing interleaves a sync update. */
export function updateCards(
	change: (cards: ServerCard[]) => ServerCard[],
): void {
	writeJsonState(SERVER_CARDS_KEY, change(readCards()).slice(-MAX_CARDS));
}

function newId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * The board as the server can see it: the window's cards (as last mirrored),
 * plus the cards the server started since, with each live session's status
 * from its agent hooks. `live` maps every running session to its status.
 */
export async function boardView(): Promise<{
	panes: BoardPane[];
	live: Map<string, string>;
}> {
	const { sessions } = await hostApi().remoteSessions.list.query();
	const cards = readCards();
	const startedAt = new Map(cards.map((card) => [card.paneId, card.startedAt]));
	const now = Date.now();
	const live = new Map<string, string>();
	for (const session of sessions) {
		const started = startedAt.get(session.paneId);
		live.set(
			session.paneId,
			// Claude takes a few seconds to fire its first hook.
			!session.lastEventType && started && now - started < STARTING_GRACE_MS
				? "working"
				: statusFromAgentEvent(session.lastEventType),
		);
	}
	const panes = new Map<string, BoardPane>();
	for (const pane of readJsonState<BoardPane[]>(BOARD_PANES_KEY, [])) {
		panes.set(pane.id, pane);
	}
	// Tags a session changed here since the window last sent its board.
	const mirroredAt = readStateEntry(BOARD_PANES_KEY)?.updatedAt ?? 0;
	const patches = readJsonState<PanePatches>(SERVER_PANE_PATCHES_KEY, {});
	for (const card of cards) {
		const known = panes.get(card.paneId);
		panes.set(card.paneId, {
			...known,
			id: card.paneId,
			name: known?.name ?? card.title,
			odinTaskTitle: known?.odinTaskTitle ?? card.title,
			odinTags: known?.odinTags ?? card.tags,
			...(card.checkout ? { odinCwd: card.checkout } : {}),
			odinQueued: !!card.queued,
		});
	}
	const view = [...panes.values()].map((pane) => {
		const status = live.get(pane.id);
		const patch = patches[pane.id];
		const tags =
			patch && patch.at > mirroredAt ? { odinTags: patch.odinTags } : {};
		return { ...pane, ...tags, ...(status ? { status } : {}) };
	});
	return { panes: view, live };
}

function launchLimits(): LaunchLimits {
	return {
		...DEFAULT_LAUNCH_LIMITS,
		...readStoreState<Partial<LaunchLimits>>("odin-launch-limits"),
	};
}

/** `launchBlocker` against this server's load and its live sessions. */
export async function serverLaunchBlocker(
	checkout: string,
	except?: string,
): Promise<string | null> {
	const { panes, live } = await boardView();
	const running = panes.filter(
		(pane) => live.has(pane.id) && pane.id !== except,
	) as unknown as Pane[];
	return (
		launchBlocker(
			machineSnapshot([...live.keys()]),
			running,
			checkout,
			launchContext()?.odinRepoPath,
			launchLimits(),
		)?.replaceAll("this Mac", "the server") ?? null
	);
}

export interface ServerLaunchInput {
	title: string;
	description: string | null;
	brief?: string | null;
	contact?: string | null;
	pageId?: string | null;
	source?: OdinSource;
	key?: string;
	tags: string[];
	skill?: string;
	repoPath?: string;
	origin: ServerCard["origin"];
	taskId?: string;
	slackRowId?: string;
}

/**
 * Start a session the way the window's `launch` does - or, when the gate is
 * shut, record it as queued for the queue tick to start.
 */
export async function serverLaunch(
	input: ServerLaunchInput,
): Promise<ServerCard> {
	const context = launchContext();
	if (!context) {
		throw new Error(
			"No session folder on the server yet - open Odin on the laptop once while connected.",
		);
	}
	const worktreePath = context.workspacePath;
	const sessionCwd = input.repoPath || worktreePath;
	const checkout = claimedCheckout(
		input.repoPath,
		worktreePath,
		context.odinRepoPath,
	);
	// A broken gauge must not be the reason a session doesn't start.
	const queuedReason = await serverLaunchBlocker(checkout).catch(() => null);

	const promptDir = `${worktreePath}/.odin`;
	await mkdir(promptDir, { recursive: true });
	const rules =
		readStoreState<{ rules?: OdinRule[] }>("odin-rules")?.rules ?? [];
	const instructions =
		readStoreState<{ instructions?: string | null }>(
			"odin-session-instructions",
		)?.instructions ?? DEFAULT_SESSION_INSTRUCTIONS;
	const promptPath = `${promptDir}/task-${slugify(input.title)}.md`;
	await writeFile(
		promptPath,
		buildPrompt(
			input.title,
			input.description,
			[],
			input.skill,
			// Nobody is watching a scheduled run.
			true,
			rules,
			checkout,
			"",
			instructions,
		),
	);
	const sessionId = randomUUID();
	let settingsArg = "";
	const settings = rulesSettings(rules, checkout);
	if (settings) {
		const settingsPath = `${promptDir}/rules-${sessionId}.json`;
		await writeFile(settingsPath, settings);
		settingsArg = ` --settings ${quote(settingsPath)}`;
	}
	const paneId = newId("pane");
	const tabId = newId("tab");
	const claude: ClaudeCommandSettings = {
		...DEFAULT_CLAUDE_COMMAND,
		...readStoreState<Partial<ClaudeCommandSettings>>("odin-claude-command"),
	};
	const command = `cd ${quote(sessionCwd)} && ${claudeLaunchWith(
		claude,
		input.title,
		`--session-id ${sessionId}${settingsArg} "$(cat '${promptPath}')"`,
		paneId,
	)}`;
	const now = Date.now();
	if (!queuedReason) {
		await hostApi().remoteSessions.open.mutate({
			paneId,
			tabId,
			cwd: sessionCwd,
			command,
		});
	}
	const card: ServerCard = {
		paneId,
		tabId,
		sessionId,
		cwd: sessionCwd,
		checkout,
		title: input.title,
		brief: input.brief ?? null,
		contact: input.contact ?? null,
		pageId: input.pageId ?? null,
		...(input.source ? { source: input.source } : {}),
		...(input.key ? { key: input.key } : {}),
		tags: input.tags,
		profileId: activeProfileId(),
		createdAt: now,
		origin: input.origin,
		...(input.taskId ? { taskId: input.taskId } : {}),
		...(input.slackRowId ? { slackRowId: input.slackRowId } : {}),
		...(queuedReason
			? { queued: { command, reason: queuedReason } }
			: { startedAt: now }),
	};
	updateCards((cards) => [...cards, card]);
	if (card.source && card.key) {
		await effects
			?.recordWork({
				source: card.source === "slack" ? "reactions" : card.source,
				externalId: card.key,
				title: card.title,
				person: card.contact,
				cwd: sessionCwd,
				sessionId,
			})
			.catch((error) => console.warn("[odin-core] work log:", error));
	}
	return card;
}

/** A queued card's command started: killed first, like the window's queue. */
async function startQueued(card: ServerCard): Promise<void> {
	if (!card.queued) return;
	await hostApi()
		.remoteSessions.kill.mutate({ paneId: card.paneId })
		.catch(() => {});
	await hostApi().remoteSessions.open.mutate({
		paneId: card.paneId,
		tabId: card.tabId,
		cwd: card.cwd,
		command: card.queued.command,
	});
	updateCards((cards) =>
		cards.map((c) =>
			c.paneId === card.paneId
				? { ...c, queued: undefined, startedAt: Date.now() }
				: c,
		),
	);
}

/**
 * The queue: the longest-waiting card the gate lets through starts. One per
 * tick, so the next decision sees the new agent on the machine.
 */
export async function drainQueue(): Promise<void> {
	const queue = readCards().filter((card) => card.queued);
	if (!queue.length) return;
	const reasons = new Map<string, string>();
	for (const card of queue) {
		const reason = await serverLaunchBlocker(card.checkout, card.paneId);
		if (!reason) {
			await startQueued(card);
			return;
		}
		reasons.set(card.paneId, reason);
	}
	// Nothing could go: say what each one waits on now.
	updateCards((cards) =>
		cards.map((card) => {
			const reason = reasons.get(card.paneId);
			if (!card.queued || !reason) return card;
			const place = queue.findIndex((q) => q.paneId === card.paneId);
			const ahead = queue[place - 1];
			const text =
				place <= 0 || !ahead
					? reason
					: `#${place + 1} in line, after "${ahead.title}"`;
			return text === card.queued.reason
				? card
				: { ...card, queued: { ...card.queued, reason: text } };
		}),
	);
}

/** A task the window queued, handed here so it starts with the laptop shut. */
export function enqueueFromLaptop(
	card: Omit<ServerCard, "origin" | "createdAt" | "profileId">,
): void {
	updateCards((cards) =>
		cards.some((c) => c.paneId === card.paneId)
			? cards
			: [
					...cards,
					{
						...card,
						origin: "laptop",
						createdAt: Date.now(),
						profileId: activeProfileId(),
					},
				],
	);
}

/**
 * `$ODIN_PORT/odin action=set store=sessions` from a server session: only a
 * card's tags can change here (an automation dropping the tag it acted on).
 * Recorded for the server's own board view and for the window to apply.
 */
export function patchPaneTags(patchJson: string): {
	ok: boolean;
	message: string;
} {
	let patch: { panes?: Record<string, { odinTags?: unknown }> };
	try {
		patch = JSON.parse(patchJson);
	} catch {
		return { ok: false, message: "patch is not JSON." };
	}
	const entries = Object.entries(patch?.panes ?? {});
	const valid = entries.filter(
		([, fields]) =>
			Object.keys(fields ?? {}).length === 1 &&
			Array.isArray(fields.odinTags) &&
			fields.odinTags.every((tag) => typeof tag === "string"),
	);
	if (!entries.length || valid.length !== entries.length) {
		return {
			ok: false,
			message:
				'On a server only card tags can change: patch={"panes":{"<paneId>":{"odinTags":[...]}}}.',
		};
	}
	const patches = readJsonState<PanePatches>(SERVER_PANE_PATCHES_KEY, {});
	const at = Date.now();
	for (const [paneId, fields] of valid) {
		patches[paneId] = { odinTags: fields.odinTags as string[], at };
	}
	// The newest few hundred: the window applies them within a sync.
	const kept = Object.entries(patches)
		.sort(([, a], [, b]) => b.at - a.at)
		.slice(0, 300);
	writeJsonState(SERVER_PANE_PATCHES_KEY, Object.fromEntries(kept));
	return { ok: true, message: `Updated ${valid.length} session(s).` };
}
