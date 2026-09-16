/**
 * Shared types for tabs/panes used by both main and renderer processes.
 * Renderer extends these with MosaicNode layout specifics.
 */

import type { ChangeCategory } from "./changes-types";

/**
 * Pane types that can be displayed within a tab
 */
export type PaneType =
	| "terminal"
	| "webview"
	| "file-viewer"
	| "chat"
	| "devtools"
	| "comment";

/**
 * Pane status for agent lifecycle indicators
 * - idle: No indicator shown (default)
 * - working: Agent actively processing (amber)
 * - permission: Agent blocked, needs user action (yellow)
 * - review: Agent completed, ready for review (green)
 * - failed: Agent turn/process ended in failure, needs attention (red)
 */
export type PaneStatus =
	| "idle"
	| "working"
	| "permission"
	| "review"
	| "failed";

/** Non-idle status for UI indicators */
export type ActivePaneStatus = Exclude<PaneStatus, "idle">;

/**
 * Status priority order (higher = more urgent).
 * Single source of truth for aggregation logic.
 *
 * `failed` sits just below `permission`: both demand attention, but a live
 * permission prompt is actionable right now, whereas a failure is terminal.
 */
export const STATUS_PRIORITY = {
	idle: 0,
	review: 1,
	working: 2,
	failed: 3,
	permission: 4,
} as const satisfies Record<PaneStatus, number>;

/**
 * Compare two statuses and return the higher priority one.
 * Useful for reducing/folding over pane statuses.
 */
export function pickHigherStatus(
	a: PaneStatus | undefined,
	b: PaneStatus | undefined,
): PaneStatus {
	const aPriority = a ? STATUS_PRIORITY[a] : 0;
	const bPriority = b ? STATUS_PRIORITY[b] : 0;
	if (aPriority >= bPriority) return a ?? "idle";
	return b ?? "idle";
}

/**
 * Get the highest priority status from an iterable of statuses.
 * Returns null if all statuses are idle/undefined (no indicator needed).
 */
export function getHighestPriorityStatus(
	statuses: Iterable<PaneStatus | undefined>,
): ActivePaneStatus | null {
	let highest: PaneStatus = "idle";

	for (const status of statuses) {
		if (!status) continue;
		if (STATUS_PRIORITY[status] > STATUS_PRIORITY[highest]) {
			highest = status;
			// Early exit for max priority
			if (highest === "permission") break;
		}
	}

	return highest === "idle" ? null : highest;
}

/**
 * Resolve what a pane's status should become when the user acknowledges it
 * (e.g. clicking a tab, focusing a pane, selecting a workspace).
 *
 * - "review"     → "idle"    (user saw the completion)
 * - "permission" → unchanged (persists until agent resumes)
 * - "working"    → unchanged (persists until agent stops)
 * - "idle"       → unchanged
 */
export function acknowledgedStatus(status: PaneStatus | undefined): PaneStatus {
	if (status === "review") return "idle";
	return status ?? "idle";
}

/**
 * File viewer display modes
 */
export type FileViewerMode = "rendered" | "raw" | "diff";

/**
 * Diff layout options for file viewer
 */
export type DiffLayout = "inline" | "side-by-side";

/**
 * File viewer pane-specific properties
 */
export interface FileViewerState {
	/** Canonical absolute file path (or remote URL for attachments) */
	filePath: string;
	/** Display mode: rendered (markdown), raw (source), or diff */
	viewMode: FileViewerMode;
	/** If true, this pane won't be reused for new file clicks (preview mode = false, pinned = true) */
	isPinned: boolean;
	/** Diff display layout */
	diffLayout: DiffLayout;
	/** Category for diff source (against-main, committed, staged, unstaged) */
	diffCategory?: ChangeCategory;
	/** Commit hash for committed category diffs */
	commitHash?: string;
	/** Canonical absolute original path for renamed files */
	oldPath?: string;
	/** Initial line to scroll to (raw mode only, transient - applied once) */
	initialLine?: number;
	/** Initial column to scroll to (raw mode only, transient - applied once) */
	initialColumn?: number;
	/** Optional user-facing name override for remote URLs/attachments */
	displayName?: string;
}

/**
 * Base Pane interface - shared between main and renderer
 */
export interface Pane {
	id: string;
	tabId: string;
	type: PaneType;
	name: string;
	userTitle?: string;
	isNew?: boolean;
	status?: PaneStatus;
	/** Odin fork: a previous-run session, resurfaced in Idle as resumable. */
	interrupted?: boolean;
	/** Odin fork: explicitly killed — stays in the hidden Completed section. */
	completed?: boolean;
	/**
	 * Odin fork: the Claude Code conversation id this pane was launched with
	 * (`claude --session-id`), so Resume can reattach to THIS conversation.
	 * Lives on the pane (persisted in app-state.json) rather than renderer
	 * localStorage, so the dev app and the packaged app share it.
	 */
	claudeSessionId?: string;
	/**
	 * Odin fork: task metadata for the board, kept on the pane (persisted in
	 * app-state.json) rather than renderer localStorage — localStorage is
	 * per-app, so the dev and packaged builds couldn't see each other's.
	 */
	odinTaskTitle?: string;
	odinContact?: string;
	odinBrief?: string;
	/** Notion pageId this session was launched from. */
	odinPageId?: string;
	/** Which Odin view started this session — the board's column sections.
	 *  Absent = started from a prompt (New Session / Work on Odin). */
	odinSource?: "slack" | "reactions" | "jira" | "pr" | "notion";
	/** Free-form labels for filtering the board (right-click a card). */
	odinTags?: string[];
	/**
	 * The generated tags have been applied to this card once. Set so a tag you
	 * deleted stays deleted — without it, the next brief puts it straight back.
	 */
	odinAutoTagged?: boolean;
	/**
	 * This card's name is no longer up for grabs — either auto-rename has had
	 * its one go at it, or you renamed it yourself. Renaming a card on every
	 * brief would move the name under you while you're reading the board.
	 */
	odinAutoTitled?: boolean;
	/**
	 * Odin fork: the profile that was active when this session was launched.
	 * The board shows only its own profile's sessions, so a work card can't
	 * turn up in the middle of a personal board. Absent on sessions started
	 * before profiles existed — read those as the default profile.
	 */
	odinProfile?: string;
	/**
	 * Odin fork: parked by dragging the card to Idle — keeps an alive-but-idle
	 * session in Idle instead of the board calling it "waiting on your input".
	 * Cleared as soon as the session moves again.
	 */
	odinParked?: boolean;
	/**
	 * Odin fork: the pane holding this session's shell — a plain terminal in the
	 * same checkout, opened from the drawer. Kept on the session so reopening
	 * the drawer reattaches to that shell instead of spawning another one.
	 */
	odinShellPaneId?: string;
	initialCwd?: string;
	url?: string; // For webview panes
	cwd?: string | null; // Current working directory
	cwdConfirmed?: boolean; // True if cwd confirmed via OSC-7, false if seeded
	fileViewer?: FileViewerState; // For file-viewer panes
	chat?: ChatPaneState; // For chat panes
	browser?: BrowserPaneState; // For browser (webview) panes
	devtools?: DevToolsPaneState; // For devtools panes
	comment?: CommentPaneState; // For comment panes
	workspaceRun?: {
		workspaceId: string;
		state: "running" | "stopped-by-user" | "stopped-by-exit";
		command?: string;
	};
}

export type WorkspaceRunState = NonNullable<Pane["workspaceRun"]>["state"];

// TODO: `initialFiles` stores base64 data URLs inline. This bloats
// the pane layout state in localStorage (v2WorkspaceLocalState
// collection). Migrate to IndexedDB blob storage — store file
// references here, actual blobs in IndexedDB keyed by session/pane ID.
// See renderer/lib/pending-attachment-store.ts for the IndexedDB pattern.
export interface ChatLaunchConfig {
	initialPrompt?: string;
	draftInput?: string;
	initialFiles?: Array<{
		data: string;
		mediaType: string;
		filename?: string;
	}>;
	metadata?: {
		model?: string;
	};
	retryCount?: number;
}

export interface ChatPaneState {
	sessionId: string | null;
	launchConfig?: ChatLaunchConfig | null;
}

/**
 * Single entry in the browser pane's navigation history
 */
export interface BrowserHistoryEntry {
	url: string;
	title: string;
	timestamp: number;
	faviconUrl?: string;
}

/**
 * Named viewport size preset for responsive testing
 */
export interface ViewportPreset {
	name: string;
	width: number;
	height: number;
}

/**
 * Browser pane-specific properties
 */
export interface BrowserLoadError {
	code: number;
	description: string;
	url: string;
}

export interface BrowserPaneState {
	currentUrl: string;
	history: BrowserHistoryEntry[];
	historyIndex: number;
	isLoading: boolean;
	error?: BrowserLoadError | null;
	viewport?: ViewportPreset | null;
}

/**
 * DevTools pane-specific properties
 */
export interface DevToolsPaneState {
	/** The pane ID of the browser pane being inspected */
	targetPaneId: string;
}

/**
 * Comment pane-specific properties (PR review / conversation comment viewer)
 */
export interface CommentPaneState {
	commentId: string;
	authorLogin: string;
	avatarUrl?: string;
	body: string;
	url?: string;
	path?: string;
	line?: number;
}

/**
 * Base Tab interface - shared fields without layout
 */
export interface BaseTab {
	id: string;
	name: string;
	userTitle?: string;
	workspaceId: string;
	createdAt: number;
}

/**
 * Base tabs state - shared between main and renderer
 */
export interface BaseTabsState {
	tabs: BaseTab[];
	panes: Record<string, Pane>;
	activeTabIds: Record<string, string | null>; // workspaceId → tabId
	focusedPaneIds: Record<string, string>; // tabId → paneId
	tabHistoryStacks: Record<string, string[]>; // workspaceId → tabId[] (MRU history)
}
