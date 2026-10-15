import type { OdinSource } from "./session-launch";

/**
 * What a remote server and the laptop tell each other about the board, through
 * the server's state store (main/odin-core/state-store.ts).
 *
 * The laptop writes what only the window knows - where sessions start, the
 * board's cards, the Night Agent's queue. The server writes what its
 * schedulers did - the sessions they started, the queue they ran, the night's
 * log - under `server:` keys, and the window adopts those into the board when
 * it next connects. No key has two writers.
 */

/** Laptop → server: where a session starts (the Odin workspace folder on the server). */
export const LAUNCH_CONTEXT_KEY = "odin-launch-context";
/** Laptop → server: the board's session cards, the fields the schedulers read. */
export const BOARD_PANES_KEY = "odin-board-panes";
/** Laptop → server: Next in line as the window last built it, for the Night Agent. */
export const NIGHT_QUEUE_KEY = "odin-night-queue";
/** Server → laptop: sessions the server started, for the window to put on the board. */
export const SERVER_CARDS_KEY = "server:cards";
/** Server → laptop: the Night Agent's bookkeeping and log. */
export const SERVER_NIGHT_KEY = "server:night";
/**
 * Server → laptop: tag changes a server session made to a card ($ODIN_PORT/odin
 * action=set store=sessions) - an automation dropping the tag it acted on.
 */
export const SERVER_PANE_PATCHES_KEY = "server:pane-patches";
/** Server only: when each automation last fired. */
export const SERVER_RUNS_KEY = "server:automation-runs";
/** Server only: Slack messages the auto-launcher already tried. */
export const SERVER_SLACK_KEY = "server:slack-auto";

export interface LaunchContext {
	/** The Odin workspace folder on the server, where feed sessions start. */
	workspacePath: string;
	/** Odin's own checkout, for the one-agent-per-checkout gate. */
	odinRepoPath: string | null;
}

/** A board card as the server sees it - what the launch gate and automations read. */
export interface BoardPane {
	id: string;
	name: string;
	status?: string;
	completed?: boolean;
	odinTaskTitle?: string;
	odinTags?: string[];
	odinCwd?: string;
	initialCwd?: string;
	odinQueued?: boolean;
}

/** Card tag changes made on the server, by pane id. t is when, in ms. */
export type PanePatches = Record<string, { odinTags: string[]; at: number }>;

/** A session a server scheduler started (or a queued one it was handed). */
export interface ServerCard {
	paneId: string;
	tabId: string;
	/** Claude's conversation id (`--session-id`), for Resume. */
	sessionId: string;
	cwd: string;
	/** The checkout it claims for the gate; "" for none. */
	checkout: string;
	title: string;
	brief: string | null;
	contact: string | null;
	pageId: string | null;
	source?: OdinSource;
	key?: string;
	tags: string[];
	profileId: string;
	createdAt: number;
	/** What started it. "laptop": the window launched it and handed its queue here. */
	origin: "automation" | "slack" | "night" | "laptop";
	/** The automation or My Tasks row it was started for. */
	taskId?: string;
	/** The Slack queue row it was started from. */
	slackRowId?: string;
	/** Held by the launch gate: the command to run once it opens. */
	queued?: { command: string; reason: string };
	/** When its agent actually started. */
	startedAt?: number;
}

/** What `launch` needs for one Next in line row (the All feed's AllLaunch). */
export interface QueueLaunch {
	key: string;
	title: string;
	description: string | null;
	contact: string | null;
	brief: string;
	pageId?: string;
	source?: OdinSource;
	skill?: string;
}

/** One row of the Night Agent's queue, as the window built it. */
export interface NightQueueRow {
	key: string;
	title: string;
	/** The All feed's source name - Tasks, Slack, Jira, GitHub, Notion. */
	source: string;
	launch: QueueLaunch;
	/** Pinned by a due date: ahead of the ranking. */
	pinned: boolean;
	/** The same ask through a second feed: the Night Agent leaves it. */
	duplicate: boolean;
	/** The row as the ranking reads it (backlogReview.rankNextInLine). */
	rank: {
		key: string;
		title: string;
		source: string;
		priority: string | null;
		person: string | null;
		context: string | null;
		due: string | null;
		ageDays: number | null;
		review: string | null;
	};
}

export interface NightQueue {
	/** Waiting rows, due-pinned first, then in feed order. */
	rows: NightQueueRow[];
	/** Settings → Backlog's sort words. */
	prompt: string;
}

export interface NightLogLine {
	/** ISO time. */
	at: string;
	event: string;
}

/** The server Night Agent's own state (`server:night`). */
export interface ServerNight {
	/** Sessions started in the current window. */
	started: number;
	/** Whether this window started a pick. */
	fromPicks: boolean;
	/** Keys tried in this window, so a row is started once a night. */
	tried: string[];
	/** Picks started, ever (newest last) - the window drops them from its list. */
	picksStarted: string[];
	/** ISO time of the last tick inside the window. */
	lastTick: string;
	/** What each tick decided, newest last. */
	log: NightLogLine[];
	/** The night's ranking: what it was asked with and what it said. */
	ranking: {
		instructions: string;
		seen: string[];
		order: string[];
		hidden: string[];
	} | null;
}

export const EMPTY_SERVER_NIGHT: ServerNight = {
	started: 0,
	fromPicks: false,
	tried: [],
	picksStarted: [],
	lastTick: "",
	log: [],
	ranking: null,
};

/** A host-service agent event, as the board reads it. */
export function statusFromAgentEvent(eventType: string | null): string {
	switch (eventType) {
		case "Start":
		case "UserPromptSubmit":
			return "working";
		case "PermissionRequest":
			return "permission";
		case "Stop":
			return "review";
		default:
			return "idle";
	}
}
