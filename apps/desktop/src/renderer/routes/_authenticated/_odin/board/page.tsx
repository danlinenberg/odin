import type { SelectProject, SelectWorkspace } from "@odin/local-db";
import { BRIEF_DIR } from "@odin/shared/constants";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@odin/ui/dropdown-menu";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@odin/ui/hover-card";
import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute } from "@tanstack/react-router";
import {
	type CSSProperties,
	Fragment,
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import type { IconType } from "react-icons";
import {
	LuBellRing,
	LuBookOpen,
	LuChevronDown,
	LuChevronLeft,
	LuChevronRight,
	LuCircleCheck,
	LuClock,
	LuCopy,
	LuEye,
	LuEyeOff,
	LuFileText,
	LuFlame,
	LuGitMerge,
	LuGitPullRequest,
	LuHourglass,
	LuLaptop,
	LuLayoutGrid,
	LuMessageSquare,
	LuMoon,
	LuPause,
	LuPlay,
	LuPlus,
	LuRadioTower,
	LuRepeat,
	LuRotateCw,
	LuServer,
	LuServerOff,
	LuSquareTerminal,
	LuStar,
	LuTerminal,
	LuUser,
} from "react-icons/lu";
import { SiJira, SiNotion, SiSlack } from "react-icons/si";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import {
	currentHostBlocker,
	currentLaunchBlocker,
	macPaceBlocker,
	moveQueuedToMac,
	startQueuedPane,
} from "renderer/hooks/useTaskQueue";
import { useHotkey } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { emojify } from "renderer/lib/emoji";
import { canClaimKeyboard } from "renderer/lib/keyboard";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { coldRestoreState } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/state";
import { Terminal } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/Terminal";
import * as terminalCache from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache";
import {
	claudeLaunch,
	remoteControlName,
	remoteControlOn,
	useClaudeCommand,
} from "renderer/stores/claude-command";
import { sessionDocKey, useDoneStore } from "renderer/stores/done";
import { useIdleClose } from "renderer/stores/idle-close";
import { useIdleCompact } from "renderer/stores/idle-compact";
import { useSessionView } from "renderer/stores/session-view";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane, PaneStatus } from "renderer/stores/tabs/types";
import { lastAgentHookAt } from "renderer/stores/tabs/useAgentHookListener";
import { boardColumn, withWaiting } from "shared/board-column";
import {
	type BoardSection,
	bySection,
	SECTION_LABEL,
} from "shared/board-section";
import { SAVE_DOC_PROMPT } from "shared/constants";
import { duplicateSessions } from "shared/duplicate-sessions";
import { type BriefUrgency, latestReply, sameReply } from "shared/latest-reply";
import { claimedCheckout } from "shared/launch-gate";
import { sessionUsageLabel } from "shared/machine-load";
import { profileOf } from "shared/odin-profile";
import {
	agentOnScreen,
	escIsHandledOnScreen,
	inputBoxEmpty,
	odinScreenStatus,
	odinScreenWrite,
	remoteConnectLine,
	spacesForCursorForward,
} from "shared/odin-screen-status";
import {
	BOARD_TAGS,
	boardTags,
	CUSTOM_TAGS_KEY,
	normalizeTag,
	readCustomTags,
} from "shared/odin-tags";
import { remoteCardsToReconnect } from "shared/remote-reconnect";

/** Tags the card shows as their own pill instead of in the #tag line. */
const PILL_TAGS = ["automation", "auto-started", "off-hours"];

import { openUrl, useInAppBrowser } from "renderer/stores/in-app-browser";
import { nextSelection, visibleSelection } from "../all/selection";
import { useSearchableItems } from "../all/use-all-items";
import { paneWorksOn } from "../all/use-start-item";
import { DropHint } from "../components/DropHint";
import { useSearchHotkey } from "../components/FeedChrome";
import {
	cardBody,
	OdinPromptDialog,
	type PromptImage,
	restartPrompt,
	sessionTitle,
	untruncatedTitle,
} from "../components/OdinPromptDialog";
import { PersonChip, personColor } from "../components/PersonChip";
import { BUTTON, PILL } from "../components/pill";
import { DueChip, OverdueMark, useReminders } from "../components/Reminders";
import {
	sessionThread,
	useReplyWatch,
	WatchMark,
	WatchPill,
	WatchReply,
} from "../components/ReplyWatch";
import { TranscriptView } from "../components/TranscriptView";
import { useBacklogReview, useReview } from "../hooks/useBacklogReview";
import { CROW_TAG } from "../hooks/useCrow";
import { endSession, useDone } from "../hooks/useDone";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useOdinProfile } from "../hooks/useOdinProfile";
import { useMyTasks } from "../hooks/useOdinTasks";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { PANE_STATUS } from "../pane-status";
import { type SweptRow, sessionFor } from "../review/verdicts";
import type { BriefMessage } from "./brief";
import {
	actionItems,
	ciRunning,
	claimOpened,
	elapsedLabel,
	jiraIssue,
	lastMessageAt,
	launchPullRequest,
	linkRefs,
	mergeCheckUrls,
	mergeConflicts,
	mergeReady,
	mergeTargets,
	nextCronFire,
	nothingLeft,
	notionPage,
	onlyLookLeft,
	onlyMergeLeft,
	prsDropped,
	pullRequests,
	reviewEnded,
	reviewedPullRequest,
	slackThread,
	sourceLink,
} from "./brief";
import { ChatView, interruptClaude, typeIntoClaude } from "./ChatView";
import {
	type CatchUpSuggestion,
	catchUpOrder,
	catchUpSuggestion,
} from "./catch-up";
import { DiffView } from "./DiffView";
import { hostStartDelay } from "./host-start-gap";
import { onIdleArrival, restoreAfterCompact } from "./idle-compact";
import { menuTop } from "./menu-fit";
import { BOARD_COLUMN_MIN_W, NextInLine, TonightCount } from "./NextInLine";
import { NightAgentLive } from "./NightAgentLive";
import { HoverBrief, MyTodos, SessionBrief } from "./SessionBrief";
import {
	PREFIX as REMIND_PREFIX,
	RemindButton,
	remindSession,
	SessionReminders,
} from "./SessionReminders";
import {
	SWITCH_SORTS,
	type SwitchSort,
	sessionOrder,
	statusAt,
} from "./session-order";
import { parkable, resumable } from "./session-pick";
import { moveToVsCode } from "./vscode-move";

/**
 * The same marks the feed tabs use, so a section header reads as its source at
 * a glance. Kept here rather than in shared/board-section - that module is
 * imported by the main process, which has no business loading React icons.
 */
const SECTION_ICON: Record<BoardSection, IconType> = {
	// Not a source - the sessions you marked as the ones that matter.
	starred: LuStar,
	// Not a source - its turn ended in the last JUST_DONE_MS.
	recent: LuCircleCheck,
	// Not a source - a task that exists but hasn't started.
	queued: LuHourglass,
	// Not a source - "Ping me" is on and nobody has answered yet.
	waiting: LuBellRing,
	// Not a source - a session you put down on purpose.
	parked: LuPause,
	slack: SiSlack,
	reactions: SiSlack,
	jira: SiJira,
	pr: LuGitPullRequest,
	notion: SiNotion,
	// Not from a feed - a session you opened yourself.
	normal: LuTerminal,
};

export const Route = createFileRoute("/_authenticated/_odin/board/")({
	component: DevBoardPage,
});

/**
 * Dev Board - kanban over live agent state, styled per the agreed mock.
 * Columns are the pane statuses the app already tracks; cards jump to the
 * pane; the input launches a new agent session into the selected workspace.
 */

const COLUMNS: { status: PaneStatus }[] = [
	{ status: "working" },
	{ status: "permission" },
	// Turn ended clean, no prompt on screen - nothing to do but ✓ done it.
	{ status: "review" },
	// Statuses reset to idle on app reload (upstream can't trust them), but the
	// PTYs live on in the daemon - alive-but-idle sessions land here instead of
	// vanishing from the board.
	{ status: "idle" },
];

interface BoardCard {
	pane: Pane;
	tabId: string;
	tabName: string;
	workspaceId: string;
	/** The workspace's own checkout - where a card with no pane cwd runs. */
	repoPath: string;
	status: PaneStatus;
}

/**
 * What the mounted terminal is showing right now, as plain text. The board's
 * other screen reads go through the daemon and come back on a timer; a
 * keypress can't wait for that, and the xterm in the drawer already holds the
 * same rows.
 */
/** The top bar's empty slot (layout.tsx) the board fills with ViewToggle. */
const VIEW_TOGGLE_SLOT_ID = "odin-view-toggle";

/** Sessions View / Board View: icon-only, in the top bar's slot. */
function ViewToggle({
	sessionsOpen,
	sessionsDisabled,
	sessionsKey,
	onSessions,
	onBoard,
}: {
	sessionsOpen: boolean;
	sessionsDisabled?: boolean;
	sessionsKey: string;
	onSessions: () => void;
	onBoard: () => void;
}) {
	const segment = (active: boolean) =>
		cn(
			"flex items-center px-2 py-[3px] disabled:opacity-40",
			active
				? "bg-primary text-primary-foreground"
				: "text-foreground/80 hover:bg-accent hover:text-foreground",
		);
	return (
		<div className="flex shrink-0 overflow-hidden rounded-full border border-primary/60 bg-card shadow-sm">
			<button
				type="button"
				aria-label="Sessions view"
				aria-pressed={sessionsOpen}
				title={`Sessions view - the first session in flight, with the session list beside it (${sessionsKey})`}
				disabled={sessionsDisabled}
				onClick={onSessions}
				className={segment(sessionsOpen)}
			>
				<LuSquareTerminal className="size-3.5" aria-hidden />
			</button>
			<button
				type="button"
				aria-label="Board view"
				aria-pressed={!sessionsOpen}
				title="Board view (the sessions keep running)"
				onClick={onBoard}
				className={segment(!sessionsOpen)}
			>
				<LuLayoutGrid className="size-3.5" aria-hidden />
			</button>
		</div>
	);
}

function visibleScreen(paneId: string): string {
	const xterm = terminalCache.get(paneId)?.xterm;
	if (!xterm) return "";
	const buffer = xterm.buffer.active;
	const lines: string[] = [];
	for (let row = 0; row < xterm.rows; row++)
		lines.push(
			buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
		);
	return lines.join("\n");
}

/** What a session is called on claude.ai under Remote Control. */
function taskName(card: BoardCard): string {
	return card.pane.odinTaskTitle ?? card.tabName;
}

/**
 * Which checkout this session runs in. `cwd` is only filled in once the pane's
 * terminal mounts (seeded there, then confirmed by OSC-7) - until someone opens
 * the session, the repo picked at launch lives only in `initialCwd`.
 */
function sessionCwd(pane: Pane): string | undefined {
	return pane.cwd ?? pane.initialCwd ?? undefined;
}

/**
 * The checkout a card runs in, in one word. Feed-launched sessions have no
 * repo of their own - they run in the workspace's checkout, so name that.
 */
function repoLabel(card: BoardCard): string {
	return (sessionCwd(card.pane) ?? card.repoPath).split("/").pop() || "repo";
}

/** The repo a card works on - a worktree session counts as its parent repo. */
function repoName(card: BoardCard): string {
	return (
		(sessionCwd(card.pane) ?? card.repoPath)
			.replace(/\/\.(claude\/)?worktrees\/.*$/, "")
			.split("/")
			.pop() || "repo"
	);
}

/** Same slug rule as useLaunchTaskSession - to locate a task's prompt file. */
function slugify(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "task"
	);
}

/**
 * How long a pane's agent hooks have to stay silent before screen-reading is
 * allowed to overrule them. Long enough that an active turn is left alone
 * entirely, short enough that a card stranded by a lost hook is corrected while
 * you're still looking at it.
 *
 * Two minutes rather than the twenty seconds this used to be: a healthy turn
 * goes quiet for as long as its longest single tool call, and measured against
 * real sessions that is over a minute - a test run, a subagent, a big search.
 * Every one of those gaps handed a mid-turn card to the scan below.
 */
const SETTLED_MS = 120_000;
/** How long after a (re)start Continue stays clickable on a live session. */
const RECENT_RESTART_MS = 5 * 60_000;
/**
 * How long the board watches a compaction it started for Claude's prompt to
 * come back, and how often it looks. A long conversation summarizes slowly.
 */
const COMPACT_WATCH_MS = 10 * 60_000;
const COMPACT_POLL_MS = 2_500;

/** The pane whose drawer was open, so a reload reopens it. */
const OPEN_DRAWER_KEY = "odin-open-drawer";

/** Width of the Odin icon rail in layout.tsx - the drawer stops here. */
const RAIL_W = 52;

/** Narrowest the drawer goes, in px. */
const MIN_DRAWER_W = 480;

// Built via string escapes - ANSI sequences are control chars by definition
const ANSI_RE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
	/\x1b\[[0-9;?<>]*[a-zA-Z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]|[\x00-\x08\x0b-\x1f]/g;
/**
 * Read-only history for a dead pane (killed or previous-run), without
 * respawning anything. A Claude session shows its conversation: Claude Code
 * draws in the alternate screen, so its scrollback is hundreds of cursor-placed
 * repaints that read as run-together words once the escapes are stripped.
 */
function HistoryView({
	card,
	live,
	onDo,
	resuming = false,
}: {
	card: BoardCard;
	live: boolean;
	/** Resume the session with this as its opening message. */
	onDo?: (text: string) => void;
	/** Resume clicked, PTY not up yet: keep the conversation (and what you sent) on screen. */
	resuming?: boolean;
}) {
	const sessionId = useCardSessionId(card);
	// Same query the card's pills run, so this is a cache hit. Claude prunes old
	// transcripts; when the file is gone, the saved screen is all that's left.
	const { error } = useCardTranscript(card, false);
	const chatView = useSessionView((s) => s.chat);
	if (sessionId && !live && !error && chatView) {
		return (
			<ChatView
				// Its sent bubbles are per pane: reused for another card, they
				// were saved under that card and showed in its chat.
				key={card.pane.id}
				paneId={card.pane.id}
				sessionId={sessionId}
				cwd={sessionCwd(card.pane) ?? card.repoPath}
				workspaceId={card.workspaceId}
				onResumeWith={resuming ? undefined : onDo}
				resuming={resuming}
			/>
		);
	}
	// A fresh launch: the conversation file isn't written until Claude's first
	// turn, and the daemon poll hasn't seen the PTY yet.
	if (error && card.pane.status === "working")
		return <StartingView label="Starting session…" />;
	if (sessionId && !live && !error) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="border-b border-border px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[.4px] text-muted-foreground">
					Conversation history · session ended
				</div>
				<TranscriptView sessionId={sessionId} />
			</div>
		);
	}
	return <ScrollbackView card={card} live={live} />;
}

/** Spinner for the gap before a session has anything to show. */
function StartingView({
	label,
	onStartOnMac,
}: {
	label: string;
	/** A task waiting on the remote host's room: start it on this Mac instead. */
	onStartOnMac?: () => void;
}) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3">
			<div className="flex items-center gap-2 text-[13px] text-working">
				<span className="size-[12px] animate-spin rounded-full border-2 border-working border-t-transparent" />
				{label}
			</div>
			{onStartOnMac && (
				<button
					type="button"
					onClick={onStartOnMac}
					className={cn(
						"rounded-[7px] px-3 py-1.5 text-xs font-semibold",
						BUTTON.secondary,
					)}
				>
					Start on this Mac instead
				</button>
			)}
		</div>
	);
}

/** The persisted PTY output, for panes with no Claude conversation behind them. */
function ScrollbackView({ card, live }: { card: BoardCard; live: boolean }) {
	// Read the persisted scrollback from disk - always reliable, unlike the
	// embedded xterm which intermittently renders blank in this drawer. Poll
	// while the session is live so the transcript stays current.
	const { data, isLoading } = electronTrpc.terminal.readHistory.useQuery(
		{ paneId: card.pane.id, workspaceId: card.workspaceId },
		live ? { refetchInterval: 1500 } : undefined,
	);
	const ref = useRef<HTMLDivElement>(null);
	const text = (data?.scrollback ?? "").replace(ANSI_RE, "");
	// biome-ignore lint/correctness/useExhaustiveDependencies: new text is the trigger to pin the view to the bottom
	useEffect(() => {
		if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
	}, [text]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="border-b border-border px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[.4px] text-muted-foreground">
				{live
					? "Session transcript · live"
					: "Conversation history · session ended"}
			</div>
			<div
				ref={ref}
				className="min-h-0 flex-1 select-text cursor-text overflow-y-auto whitespace-pre-wrap break-words bg-background px-4 py-3 font-mono text-[11.5px] leading-relaxed text-soft-foreground"
			>
				{isLoading
					? "loading history…"
					: text.trim()
						? text
						: "No saved history for this session."}
			</div>
		</div>
	);
}

/**
 * What "Ping me" watches for a session: its Slack thread or Jira ticket, and
 * every PR it launched on or opened, for approval. Not just the newest few - a
 * session often opens the PR you wait on, then a dozen that auto-merge with no
 * review. Merged ones cost one check, then the watcher skips them.
 */
function useSessionWatchKeys(card: BoardCard | undefined): string[] {
	const paneId = card?.pane.id ?? "";
	const mirrored = usePaneMeta((s) => s.sessionIdByPane[paneId]);
	const added = usePaneMeta((s) => s.linksByPane[paneId]);
	const brief = usePaneMeta((s) => s.briefByPane[paneId]);
	const sessionId = card?.pane.claudeSessionId ?? mirrored ?? null;
	const { data: transcript } =
		electronTrpc.terminal.readClaudeTranscript.useQuery(
			{ sessionId: sessionId ?? "" },
			{ enabled: !!sessionId, retry: false, staleTime: 60_000 },
		);
	if (!card) return [];
	const thread = sessionThread({
		...card.pane,
		brief,
		links: [
			transcript ? slackThread(transcript.links ?? transcript.messages) : null,
			...(added ?? []).map((link) =>
				typeof link === "string" ? link : link.url,
			),
		],
	});
	// The conversations it left a draft in: once you send it, you wait there.
	const drafts = (transcript?.slackDrafts ?? []).map((id) => `slack:${id}`);
	const prs = new Set(
		[
			launchPullRequest(card.pane.odinBrief),
			...(transcript ? pullRequests(transcript.messages) : []),
		].flatMap((pr) => (pr ? [`pr:${pr.url}`] : [])),
	);
	return [...new Set([thread, ...drafts, ...prs])].filter(
		(k): k is string => !!k,
	);
}

/**
 * Keeps each watched session's watch list current: a draft or PR it makes
 * after you turned Ping me on is watched too.
 */
function WatchKeySyncs({ cards }: { cards: BoardCard[] }) {
	// A string, so the board only re-renders this when the watched set changes.
	const watched = useReplyWatch((s) =>
		[...new Set(Object.values(s.watches).flatMap((w) => w.paneId ?? []))]
			.sort()
			.join("\n"),
	).split("\n");
	return cards
		.filter((card) => watched.includes(card.pane.id))
		.map((card) => <WatchKeySync key={card.pane.id} card={card} />);
}

function WatchKeySync({ card }: { card: BoardCard }) {
	const keys = useSessionWatchKeys(card);
	const joined = keys.join("\n");
	const paneId = card.pane.id;
	useEffect(() => {
		if (joined) useReplyWatch.getState().add(joined.split("\n"), paneId);
	}, [joined, paneId]);
	return null;
}

/** The conversation behind a card, for the pills that read it. */
function useCardSessionId(card: BoardCard): string | null {
	const mirrored = usePaneMeta((s) => s.sessionIdByPane[card.pane.id]);
	return card.pane.claudeSessionId ?? mirrored ?? null;
}

/**
 * The agent's `inline code` as code, not as literal backticks; the prose
 * between goes through `prose` (Catch up links its PRs there).
 */
function withCode(
	text: string,
	prose: (part: string) => React.ReactNode = (part) => part,
): React.ReactNode[] {
	return text.split("`").map((part, i) =>
		i % 2 ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: a fixed split, never reordered
			<code key={i} className="rounded bg-secondary px-1 text-[0.9em]">
				{part}
			</code>
		) : (
			// biome-ignore lint/suspicious/noArrayIndexKey: a fixed split, never reordered
			<Fragment key={i}>{prose(part)}</Fragment>
		),
	);
}

/**
 * Catch up's card: what the issue was, what's yours to do, where it stands
 * and what we did, and the PRs, tickets and threads it's about - nothing else.
 * The conversation and the brief panel are one click away, not on screen:
 * catching up is deciding Next or Done, not reading.
 */
function CatchUpCard({
	card,
	title,
	suggestion,
	onShowSession,
}: {
	card: BoardCard;
	/** The board's title for it - finds the transcript of a session with no id. */
	title: string;
	suggestion: CatchUpSuggestion;
	onShowSession: () => void;
}) {
	const { data: transcript } = useCardTranscript(card, false);
	const sessionId = useCardSessionId(card);
	const { data: written } =
		electronTrpc.terminal.summarizeClaudeSession.useQuery(
			{ sessionId: sessionId ?? "" },
			{ enabled: !!sessionId, retry: false, staleTime: 30_000 },
		);
	// The agent's own list, verbatim; the brief's one-liner when it left none.
	const todo = transcript ? actionItems(transcript.messages) : [];
	// "Merge imagen-public-mcp #2" opens #2 - the PRs and ticket the session quoted.
	const quoted = transcript ? (transcript.links ?? transcript.messages) : [];
	const prs = pullRequests(quoted);
	const issue = jiraIssue(quoted);
	const text = (value: string) =>
		withCode(value, (part) =>
			linkRefs(part, prs, issue).map(({ text: run, url }, i) =>
				url ? (
					// An <a>, not a <button>: a button lays out inline-block whatever its
					// display, so "PR #1." could wrap before its period. The click is
					// stopped, so the app window doesn't navigate; main opens it.
					<a
						// biome-ignore lint/suspicious/noArrayIndexKey: a fixed split, never reordered
						key={i}
						href={url}
						title={url}
						onClick={(event) => {
							event.preventDefault();
							openUrl(url);
						}}
						className="text-link hover:underline"
					>
						{run}
					</a>
				) : (
					run
				),
			),
		);
	// The notes you submitted - the question you saved for when it finished.
	const hasTodos = usePaneMeta((s) => !!s.todosByPane[card.pane.id]);
	const label = "mb-1.5 text-[11px] font-semibold uppercase tracking-[.4px]";
	return (
		<div className="flex min-h-0 flex-1 select-text cursor-text flex-col gap-6 overflow-y-auto px-8 py-7">
			<SuggestionBox suggestion={suggestion} text={text} />
			{/* What it's about first, at the size of the action items: you can't
			    decide Next or Done on a session you don't recognise. Its label is
			    grey: amber is the one label that means something - yours to do. */}
			{written?.goal && (
				<div>
					<div className={cn(label, "text-muted-foreground")}>The issue</div>
					<div className="text-[15px] leading-relaxed text-foreground">
						{text(written.goal)}
					</div>
				</div>
			)}
			<div>
				<div className={cn(label, "text-attention")}>Your action items</div>
				{todo.length > 0 ? (
					<ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-foreground">
						{todo.map((item) => (
							<li key={item} className="break-words">
								{text(item)}
							</li>
						))}
					</ol>
				) : (
					<div className="text-[15px] leading-relaxed text-foreground">
						{written?.next
							? text(written.next)
							: sessionId
								? "reading the conversation…"
								: "-"}
					</div>
				)}
			</div>
			{hasTodos && (
				<div>
					<div className={cn(label, "text-attention")}>Your to-dos</div>
					<MyTodos paneId={card.pane.id} />
				</div>
			)}
			{written?.status && (
				<div>
					<div className={cn(label, "text-muted-foreground")}>
						Where it stands
					</div>
					<div className="text-[13.5px] leading-relaxed text-soft-foreground">
						{text(written.status)}
					</div>
				</div>
			)}
			{written?.done && (
				<div>
					<div className={cn(label, "text-muted-foreground")}>What we did</div>
					<div className="text-[13.5px] leading-relaxed text-soft-foreground">
						{text(written.done)}
					</div>
				</div>
			)}
			<SessionBrief
				resourcesOnly
				paneId={card.pane.id}
				cwd={card.pane.cwd ?? null}
				claudeSessionId={card.pane.claudeSessionId ?? null}
				marker={title}
				live={false}
				launch={card.pane.odinBrief}
			/>
			<button
				type="button"
				onClick={onShowSession}
				title="Leave Catch up and open this session"
				className={cn(
					"mt-auto self-start rounded-[7px] px-3 py-1.5 text-xs font-semibold",
					BUTTON.secondary,
				)}
			>
				Back to session
			</button>
		</div>
	);
}

const SUGGESTION = {
	done: {
		icon: LuCircleCheck,
		what: "Suggested: Done",
		box: "border-success/40 bg-success/10",
		ink: "text-success-ink",
		button: "✓ Done",
		style: BUTTON.done,
	},
	duplicate: {
		icon: LuCopy,
		what: "Suggested: Close as duplicate",
		box: "border-border bg-secondary",
		ink: "text-muted-foreground",
		button: "Close as duplicate",
		style: BUTTON.done,
	},
	merge: {
		icon: LuGitMerge,
		what: "Suggested: Merge",
		box: "border-primary/40 bg-primary/10",
		ink: "text-primary-ink",
		button: "Open PR to merge",
		style: BUTTON.primary,
	},
	yours: {
		icon: LuUser,
		what: "Yours to do",
		box: "border-attention/40 bg-attention/10",
		ink: "text-attention-ink",
		button: "Open session",
		style: BUTTON.remind,
	},
} as const;

/** Catch up's call on this card and why - the reason you can press Enter on. */
function SuggestionBox({
	suggestion,
	text,
}: {
	suggestion: CatchUpSuggestion;
	text: (value: string) => React.ReactNode;
}) {
	const look = SUGGESTION[suggestion.kind];
	const Icon = look.icon;
	return (
		<div
			className={cn("-mx-2 flex gap-3 rounded-xl border px-3.5 py-3", look.box)}
		>
			<Icon className={cn("mt-0.5 size-[18px] shrink-0", look.ink)} />
			<div className="min-w-0">
				<div
					className={cn(
						"text-[11px] font-bold uppercase tracking-[.4px]",
						look.ink,
					)}
				>
					{look.what}
				</div>
				<div className="mt-0.5 break-words text-[14.5px] leading-snug text-foreground">
					{text(suggestion.why)}
				</div>
				<div className="mt-1 text-[11.5px] text-muted-foreground">
					{suggestion.from}
				</div>
			</div>
		</div>
	);
}

/**
 * "This one shipped a PR" - the fact you scan the board for, on the card
 * instead of behind a click. Read from the same transcript the drawer reads, so
 * react-query shares one fetch per session. Newest PR only; the drawer lists
 * the rest.
 */
function useCardTranscript(card: BoardCard, live: boolean) {
	const sessionId = useCardSessionId(card);
	return electronTrpc.terminal.readClaudeTranscript.useQuery(
		{ sessionId: sessionId ?? "" },
		{
			enabled: !!sessionId,
			retry: false,
			staleTime: 60_000,
			// The transcript only grows while the agent is working; a parked
			// session's is frozen.
			refetchInterval: live ? 60_000 : false,
		},
	);
}

/**
 * The Review sweep said the thing this session is working is done or gone -
 * a merged PR, a closed ticket, a thread someone else answered. Same link
 * Review uses to name the session, read the other way round. A suggestion:
 * the card is still yours to close.
 *
 * Never on an auto-started card: your launch reaction is the ask, so "nobody
 * asked" is wrong by construction.
 */
function useDropFor(pane: Pane | undefined) {
	return useReview((review) => dropRowFor(review.swept, pane));
}

function dropRowFor(swept: SweptRow[], pane: Pane | undefined) {
	return pane && !pane.odinTags?.includes("auto-started")
		? swept.find(
				(r) =>
					r.verdict === "DROP" && sessionFor(r, [pane], new Map()) === pane.id,
			)
		: undefined;
}

function DropPill({ pane }: { pane: Pane }) {
	const row = useDropFor(pane);
	return row ? <DropHint row={row} /> : null;
}

/** Another live card is on the same ask. The click opens it, to Done one. */
function DuplicateHint({
	other,
	titleOf,
}: {
	other: BoardCard | undefined;
	titleOf: (card: BoardCard) => string;
}) {
	if (!other) return null;
	return (
		<button
			type="button"
			title="Looks like the same ask as another session - open it"
			onClick={(event) => {
				// The card itself opens its own drawer; the hint opens the other one.
				event.stopPropagation();
				usePendingFocus.getState().focus(other.pane.id);
			}}
			className={cn(
				"mt-1 line-clamp-2 w-full rounded-[5px] px-[7px] py-px text-left text-[11px] font-medium hover:brightness-125",
				PILL.attention,
			)}
		>
			Duplicate? Same ask as “{titleOf(other)}”
		</button>
	);
}

function MergeOnlyPill({ card }: { card: BoardCard }) {
	const { data } = useCardTranscript(card, card.status === "working");
	if (!data || !onlyMergeLeft(data.messages)) return null;
	// The PR the merge item names ("Merge #12"), else the newest one.
	const pr = mergeTargets(data.messages)[0];
	return (
		<button
			type="button"
			disabled={!pr}
			title={
				pr
					? `Open ${pr.url} to merge it`
					: "The only action item left is merging the PR"
			}
			onClick={(event) => {
				// The card itself opens the drawer; the pill opens GitHub.
				event.stopPropagation();
				if (pr) openUrl(pr.url);
			}}
			className={cn(
				"inline-flex items-center gap-1 rounded-[5px] px-[7px] text-[11px] font-medium enabled:hover:brightness-125",
				PILL.success,
			)}
		>
			<LuGitMerge className="size-3" />
			Just merge{pr ? ` #${pr.number}` : ""}
		</button>
	);
}

/**
 * The PRs a card is about. A card launched on a PR leads with that PR: the
 * newest one the agent quoted is often just a related PR it mentioned.
 */
function useCardPrs(card: BoardCard, live: boolean) {
	const { data } = useCardTranscript(card, live);
	const quoted = data ? pullRequests(data.messages) : [];
	const launched = launchPullRequest(card.pane.odinBrief);
	const prs = launched
		? [launched, ...quoted.filter((pr) => pr.url !== launched.url)]
		: quoted;
	return {
		prs,
		review: reviewedPullRequest(card.pane.odinBrief, data?.messages ?? []),
	};
}

/** Someone else's PR, waiting on my review. The pill opens it on GitHub. */
function ReviewPill({ card }: { card: BoardCard }) {
	const { review } = useCardPrs(card, card.status === "working");
	if (!review) return null;
	return (
		<button
			type="button"
			title={`Open ${review.url} to review it`}
			onClick={(event) => {
				// The card itself opens the drawer; the pill opens GitHub.
				event.stopPropagation();
				openUrl(review.url);
			}}
			className={cn(
				"inline-flex items-center gap-1 rounded-[5px] px-[7px] text-[11px] font-medium hover:brightness-125",
				PILL.attention,
			)}
		>
			<LuGitPullRequest className="size-3" />
			Review #{review.number}
		</button>
	);
}

function PrPill({ card, live }: { card: BoardCard; live: boolean }) {
	const { prs } = useCardPrs(card, live);
	const pr = prs[0];
	if (!pr) return null;
	// Plain text: a click falls through to the card and opens the drawer.
	return (
		<span>
			PR #{pr.number}
			{prs.length > 1 ? ` +${prs.length - 1}` : ""}
		</span>
	);
}

function NotionPill({ card, live }: { card: BoardCard; live: boolean }) {
	const { data } = useCardTranscript(card, live);
	const page = data ? notionPage(data.messages) : null;
	if (!page) return null;
	// Plain text, like PrPill: a click falls through to the card and opens the drawer.
	return <span title={page.title ?? page.url}>Notion</span>;
}

/**
 * Which repo this card's work landed in.
 *
 * The pane only records where it was launched, and every feed-started session
 * launches in the same catch-all directory - so the old label read `dev` on
 * card after card. The transcript records where the agent actually went, and
 * a worktree resolves to the repo that owns it rather than its branch name.
 * Falls back to the launch directory while the transcript is still loading, or
 * for a pane too old to carry a conversation id.
 */
function RepoPill({ card }: { card: BoardCard }) {
	const sessionId = useCardSessionId(card);
	const { data } = electronTrpc.repos.workingRepoName.useQuery(
		{ claudeSessionId: sessionId ?? "" },
		{ enabled: !!sessionId, retry: false, staleTime: 60_000 },
	);
	return (
		<span
			title={data?.checkout ?? sessionCwd(card.pane) ?? card.repoPath}
			className="truncate"
		>
			{data?.name ?? repoLabel(card)}
		</span>
	);
}

/**
 * Where a session's shell really is, next to where the session's work is: its
 * PRs' worktrees and the checkout it worked in.
 */
function useShellPlace(card: BoardCard, shell: Pane) {
	const sessionId = useCardSessionId(card);
	const { data } = electronTrpc.repos.workingRepoName.useQuery(
		{ claudeSessionId: sessionId ?? "" },
		{ enabled: !!sessionId, retry: false, staleTime: 60_000 },
	);
	// Live PTYs and where each one really is. zsh here sends no OSC-7, so a
	// pane's `cwd` only knows where Odin opened it; the process table knows more.
	const { data: metrics } = electronTrpc.resourceMetrics.getSnapshot.useQuery(
		undefined,
		{ refetchInterval: 5_000 },
	);
	const live = metrics?.workspaces.flatMap((w) => w.sessions) ?? [];
	const { data: cwds } = electronTrpc.terminal.shellCwds.useQuery(
		{ pids: live.map((session) => session.pid) },
		{ enabled: live.length > 0, refetchInterval: 5_000 },
	);
	const cwdOfPane = (paneId: string) => {
		const pid = live.find((session) => session.paneId === paneId)?.pid;
		return pid ? cwds?.[pid] : undefined;
	};
	const here = cwdOfPane(shell.id) ?? shell.cwd ?? shell.initialCwd;
	const inside = (dir: string | null | undefined, root: string) =>
		!!dir && (dir === root || dir.startsWith(`${root}/`));
	/**
	 * In `root` itself - a worktree checked out under it (`.worktrees/x`) is its
	 * own checkout, not the clone's.
	 */
	const inCheckout = (dir: string | null | undefined, root: string) =>
		inside(dir, root) &&
		!/^\/(?:\.claude\/)?\.?worktrees\//.test(
			(dir as string).slice(root.length),
		);
	const workplaces = [
		...(data?.pullRequests ?? []).map((pr) => pr.worktree),
		data?.worktree,
		data?.checkout,
	].filter((dir): dir is string => !!dir);
	const atWork = workplaces.some((root) => inCheckout(here, root));
	return { here, atWork };
}

/**
 * ❯ Shell's dot: green when the shell is live and in this session's work or
 * running what its agent launched, amber when it's live but somewhere else,
 * red when its PTY is gone.
 */
function ShellDot({
	card,
	shell,
	alive,
}: {
	card: BoardCard;
	shell: Pane;
	alive: boolean;
}) {
	const { here, atWork } = useShellPlace(card, shell);
	const where = here?.replace(/^\/Users\/[^/]+/, "~");
	const [title, color] = !alive
		? ["Disconnected - open it to start a new one", "bg-danger"]
		: atWork || shell.odinAgentRun
			? [`Live, in ${where}`, "bg-success"]
			: [
					`Live, but in ${where ?? "an unknown directory"} - not in this session's worktree`,
					"bg-attention",
				];
	return (
		<span
			title={title}
			className={cn("inline-block size-[6px] rounded-full", color)}
		/>
	);
}

/**
 * The session's Shells - the main one and each named one an agent ran - and
 * the folder the shown one is in. Picking a Shell switches the drawer to it.
 */
function ShellPlaceMenu({
	card,
	shell,
	shells,
	onSelectShell,
	onOpenInVsCode,
}: {
	card: BoardCard;
	shell: Pane;
	/** Every Shell of the session, by name ("" is the main one). */
	shells: (readonly [string, Pane])[];
	onSelectShell: (name: string) => void;
	onOpenInVsCode: (dir: string) => void;
}) {
	const { here } = useShellPlace(card, shell);
	const basename = (dir: string) => dir.split("/").pop() || dir;
	const where = here?.replace(/^\/Users\/[^/]+/, "~");
	const [open, setOpen] = useState(false);
	const shownName = shells.find(([, pane]) => pane.id === shell.id)?.[0];
	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					title={where ? `Shell is in ${where}` : "This session's Shells"}
					className="flex min-w-0 max-w-[200px] items-center gap-1 rounded-r-md border-l border-background bg-secondary px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
				>
					<span className="truncate">
						{shownName || (here ? basename(here) : "…")}
					</span>
					<span className="text-[9px] opacity-70">▾</span>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-80">
				<DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
					This session's Shells
				</DropdownMenuLabel>
				{shells.map(([name, pane]) => (
					<DropdownMenuItem
						key={pane.id}
						onSelect={() => onSelectShell(name)}
						className="flex items-center gap-2 text-xs"
					>
						<span className="w-3 text-primary">
							{pane.id === shell.id ? "✓" : ""}
						</span>
						<span className="font-semibold">❯ {name || "Shell"}</span>
					</DropdownMenuItem>
				))}
				{here && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							title="Open this folder in VS Code, and continue this conversation there"
							onSelect={() => onOpenInVsCode(here)}
							className="flex items-center gap-2 text-xs"
						>
							<span className="w-3" />
							<span className="min-w-0 flex-1 truncate text-muted-foreground">
								{where}
							</span>
							<span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
								VS Code
							</span>
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * How long this card has been sitting - measured from the last message in the
 * conversation, which is the thing you actually want to know ("nobody has
 * touched this in two days"). The board's own "in this status since" clock is
 * only a fallback: it starts when the board process first saw the pane, so it
 * reads a few minutes for every card after a reload.
 */
function AgePill({
	card,
	live,
	fallback,
}: {
	card: BoardCard;
	live: boolean;
	fallback: number | undefined;
}) {
	const { data } = useCardTranscript(card, live);
	const label = elapsedLabel(
		(data ? lastMessageAt(data.messages) : null) ?? fallback,
	);
	if (!label) return null;
	return (
		<span
			title="Since the last message in this session"
			className="whitespace-nowrap"
		>
			{label === "now" ? label : `${label} ago`}
		</span>
	);
}

/** How long a card that just landed in Done keeps saying so. */
const JUST_DONE_MS = 10 * 60_000;

/**
 * When the app last took focus; Infinity while it's in the background. The
 * just-done countdown only runs while you're looking, so a card that finished
 * while you were away still says so when you come back.
 */
function useFocusedAt(): number {
	const [focusedAt, setFocusedAt] = useState(() =>
		document.hasFocus() ? 0 : Number.POSITIVE_INFINITY,
	);
	useEffect(() => {
		const onFocus = () => setFocusedAt(Date.now());
		const onBlur = () => setFocusedAt(Number.POSITIVE_INFINITY);
		window.addEventListener("focus", onFocus);
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("blur", onBlur);
		};
	}, []);
	return focusedAt;
}

/**
 * Time left on the just-done countdown, which starts at whichever is later:
 * entering the column, or the app taking focus. `since` 0 (restored off disk)
 * never counts.
 */
function justDoneLeft(
	since: number | undefined,
	focusedAt: number,
	now = Date.now(),
): number {
	if (!since) return 0;
	return Math.max(since, focusedAt) + JUST_DONE_MS - now;
}

/**
 * "just done" on a card whose turn ended in the last JUST_DONE_MS you had the
 * app open, so the one that finished while you looked away stands out.
 */
function JustDonePill({
	since,
	focusedAt,
}: {
	since: number | undefined;
	focusedAt: number;
}) {
	const [now, setNow] = useState(Date.now);
	const left = justDoneLeft(since, focusedAt, now);
	useEffect(() => {
		if (left <= 0 || left === Number.POSITIVE_INFINITY) return;
		const id = setTimeout(() => setNow(Date.now()), left);
		return () => clearTimeout(id);
	}, [left]);
	if (left <= 0) return null;
	return (
		<span
			title="Its turn ended in the last 10 minutes you had Odin open"
			className={cn(
				"inline-flex items-center rounded-[5px] px-[7px] text-[11px] font-medium",
				PILL.success,
			)}
		>
			just done
		</span>
	);
}

/**
 * This session is running under `/loop` - it will wake itself up again, so an
 * idle card isn't done. Read from the schedule calls in its transcript; only
 * asked of a session whose claude is still running, since the schedule dies
 * with it.
 */
function LoopPill({ card }: { card: BoardCard }) {
	const { data, refetch } = useCardTranscript(card, true);
	// The schedule is booked at the very end of a turn - re-read as the card
	// settles, or the last poll mid-turn misses it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-read on status change only
	useEffect(() => {
		void refetch();
	}, [card.status]);
	// Tick so the countdown moves on an idle card nobody re-renders.
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(id);
	}, []);
	const loop = data?.loop;
	if (!loop) return null;
	const nextAt =
		loop.kind === "wakeup"
			? Date.parse(loop.schedule)
			: nextCronFire(loop.schedule, now);
	// A wakeup past its fire time is mid-turn, not "in -3m".
	const countdown = nextAt && nextAt > now ? elapsedLabel(now, nextAt) : null;
	const at = nextAt
		? new Date(nextAt).toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			})
		: null;
	const next = [
		loop.kind === "cron" && `cron ${loop.schedule}`,
		at && `next run ${at}`,
	]
		.filter(Boolean)
		.join(" - ");
	return (
		<span
			title={`Under /loop - ${next}${loop.prompt ? `\n${loop.prompt}` : ""}`}
			className={cn(
				"inline-flex items-center gap-1 rounded-[5px] px-[7px] text-[11px] font-medium",
				PILL.attention,
			)}
		>
			<LuRepeat className="size-3" aria-hidden />
			{countdown
				? `Loop · ${countdown === "now" ? "<1m" : `in ${countdown}`}`
				: "Loop"}
		</span>
	);
}

/**
 * The badge that answers "which of these is eating the Mac". The header chip
 * already says nine sessions hold 11 GB; this says which three of them do.
 *
 * Same snapshot the chip reads - one query, shared by every card through the
 * React Query cache. Only a heavy session gets one; a parked session's few
 * hundred MB is noise on the card.
 */
function LoadPill({ card }: { card: BoardCard }) {
	const { data } = electronTrpc.resourceMetrics.getSnapshot.useQuery(
		undefined,
		{ refetchInterval: 5_000 },
	);
	const usage = data?.workspaces
		.flatMap((workspace) => workspace.sessions)
		.find((session) => session.paneId === card.pane.id);
	if (!usage) return null;
	const { label, heavy } = sessionUsageLabel(usage);
	if (!heavy) return null;
	return (
		<span
			title="What this session's processes are holding right now"
			className={cn(
				"inline-flex items-center gap-1 rounded-[5px] px-[7px] text-[11px] font-medium tabular-nums",
				PILL.attention,
			)}
		>
			<LuFlame className="size-3 shrink-0" aria-hidden />
			{label}
		</span>
	);
}

/**
 * The session's shell, and whether anything is still running in it. A dev
 * server that crashed leaves the shell alive at its prompt - blue would lie.
 * `busy` comes from the same process snapshot LoadPill reads; until it has
 * answered (or on a build whose main process predates it) the chip stays blue.
 */
function ShellChip({
	shellPaneId,
	alive,
}: {
	shellPaneId: string;
	alive: boolean;
}) {
	const { data } = electronTrpc.resourceMetrics.getSnapshot.useQuery(
		undefined,
		{ refetchInterval: 5_000 },
	);
	const busy = data?.workspaces
		.flatMap((workspace) => workspace.sessions)
		.find((session) => session.paneId === shellPaneId)?.busy;
	const [title, label, className] = !alive
		? [
				"This session's shell has exited - open it to start a new one",
				"Shell exited",
				`${PILL.danger} font-semibold`,
			]
		: busy === false
			? [
					"The shell is at its prompt - whatever you ran in it has stopped",
					"Shell stopped",
					`${PILL.attention} font-semibold`,
				]
			: ["This session has a shell running", "Shell", PILL.success];
	return (
		<span
			title={title}
			className={cn(
				"inline-flex items-center gap-1 rounded-[5px] px-[7px] text-[11px] font-medium",
				className,
			)}
		>
			<LuTerminal className="size-3" aria-hidden />
			{label}
		</span>
	);
}

/**
 * Hover info for a board card: full title, status, and the session's latest
 * output (one-shot snapshot of live panes).
 */
function CardHoverContent({
	card,
	text,
}: {
	card: BoardCard;
	/** The full message, when the board has it (Slack feed, launch brief). */
	text: string | null;
}) {
	// Hover shows ONE thing: what this task is about. The live terminal output
	// belongs in the drawer, not a tooltip.
	//
	// Prefer what was persisted on the pane at launch (shared by every build);
	// then the legacy localStorage mirror; then the task's prompt file on disk,
	// which is all an older session left behind.
	const legacyBrief = usePaneMeta((s) => s.briefByPane[card.pane.id]);
	const legacyTitle = usePaneMeta((s) => s.titleByPane[card.pane.id]);
	const legacyContact = usePaneMeta((s) => s.contactByPane[card.pane.id]);
	const title = emojify(
		card.pane.odinTaskTitle ??
			legacyTitle ??
			card.pane.userTitle ??
			card.pane.name ??
			card.tabName,
	);
	const contact = card.pane.odinContact ?? legacyContact ?? null;
	const known = card.pane.odinBrief ?? legacyBrief ?? null;

	const promptPath = card.pane.cwd
		? `${card.pane.cwd}/${BRIEF_DIR}/task-${slugify(title)}.md`
		: null;
	const { data: promptFile } = electronTrpc.filesystem.readFile.useQuery(
		{
			workspaceId: card.workspaceId,
			absolutePath: promptPath ?? "",
			encoding: "utf-8",
		},
		{ enabled: !known && !!promptPath, retry: false },
	);
	const fileBrief =
		promptFile && "content" in promptFile
			? String(promptFile.content)
					.replace(/^Task:\s*/i, "")
					.replace(/\n+Work in the current workspace\.[\s\S]*$/i, "")
					.trim()
			: null;
	// The launch-time brief is usually just the title - don't repeat it.
	const summary =
		text ?? (known && known.trim() !== title.trim() ? known : fileBrief);
	const sessionId = useCardSessionId(card);

	return (
		<div className="flex flex-col gap-2">
			<div className="whitespace-pre-wrap break-words text-[13px] font-semibold text-foreground">
				{title}
			</div>
			{contact && <PersonChip name={contact} />}
			{summary && (
				<div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-soft-foreground">
					{summary}
				</div>
			)}
			<HoverBrief sessionId={sessionId} />
		</div>
	);
}

/**
 * Right-click menu for a session card: star it, and the board's tags to toggle.
 * Positioned at the cursor; closes on Escape or click-outside.
 *
 * The built-in list is closed (shared/odin-tags); the field at the bottom adds
 * your own, and × forgets one - its cards keep it in app-state, just unshown.
 */
/** The tower a session wears beside its title while Remote Control is on for it. */
function RemoteMark({ paneId }: { paneId: string }) {
	const on = useClaudeCommand(
		(s) => s.remoteControl === "selected" && s.remotePanes.includes(paneId),
	);
	if (!on) return null;
	return (
		<LuRadioTower
			title="Remote Control on - follow it in claude.ai/code or the Claude app"
			className="mr-1 inline size-3.5 align-[-2px] text-primary"
		/>
	);
}

type HostState = "live" | "connecting" | "off";

/**
 * A remote pane is "live" only once Claude is drawn on its screen. One still
 * reaching its host is "connecting" (the expired AWS sign-in it waits on
 * included), and so is a blank screen: a Restart clears it before the helper
 * prints anything. One whose connect failed is "off".
 */
function connectStateOf(screen: string): HostState {
	const line = remoteConnectLine(screen);
	if (line) return line.startsWith("Could not connect") ? "off" : "connecting";
	return agentOnScreen(screen) ? "live" : "connecting";
}

/**
 * The shape says the state, not only the color: the session list's status dots
 * use the same green, yellow and red for Final Review, Needs you and Failed.
 */
const HOST_MARK: Record<
	HostState,
	{ Icon: IconType; ink: string; title: (host: string) => string }
> = {
	live: {
		Icon: LuServer,
		ink: "text-success",
		title: (host) =>
			`Connected to ${host}, in tmux - it keeps going with this computer shut`,
	},
	connecting: {
		Icon: LuServer,
		ink: "animate-pulse text-attention",
		title: (host) => `Connecting to ${host}...`,
	},
	off: {
		Icon: LuServerOff,
		ink: "text-danger",
		title: (host) => `Not connected to ${host} - Resume connects again`,
	},
};

/**
 * The server a session wears beside its title while it runs on a remote host:
 * green while connected to Claude there, yellow and pulsing while connecting,
 * red and struck through while not.
 */
function HostMark({ paneId, state }: { paneId: string; state: HostState }) {
	const host = useTabsStore((s) => s.panes[paneId]?.odinRemote);
	if (!host) return null;
	const { Icon, ink, title } = HOST_MARK[state];
	return (
		<Icon
			title={title(host)}
			className={cn("mr-1 inline size-3.5 align-[-2px]", ink)}
		/>
	);
}

function TagMenu({
	x,
	y,
	tags,
	allTags,
	customTags,
	starred,
	onStar,
	onDone,
	onPark,
	onDocs,
	onRestart,
	onRunHere,
	onRemind,
	watching,
	watchWhat,
	onWatch,
	remote,
	onRemote,
	onSaveDoc,
	onKeep,
	onToggle,
	onAdd,
	onForget,
	onClose,
}: {
	x: number;
	y: number;
	tags: string[];
	allTags: string[];
	customTags: string[];
	starred: boolean;
	onStar: () => void;
	onDone: () => void;
	/** Set unless it already sits in Idle. */
	onPark?: () => void;
	/** Set once the session has a conversation to keep under Docs. */
	onDocs?: () => void;
	/** Set while the session has a conversation to reopen. */
	onRestart?: () => void;
	/** A remote session, moved to this computer. */
	onRunHere?: () => void;
	onRemind: (day: string) => void;
	/** Whether the session's thread or PR pings you; unset when it has neither. */
	watching?: boolean;
	/** What it watches, for the label: "replies", "approval" or both. */
	watchWhat?: string;
	onWatch: () => void;
	/** Remote Control for this one session; unset unless Settings says "Selected sessions". */
	remote?: boolean;
	onRemote: () => void;
	/** Set while the agent runs - it writes the doc, so a closed session can't. */
	onSaveDoc?: () => void;
	/** Set when the sweep suggests dropping this session. */
	onKeep?: () => void;
	onToggle: (tag: string) => void;
	onAdd: (tag: string) => void;
	onForget: (tag: string) => void;
	onClose: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [draft, setDraft] = useState("");
	// Tags fold to one row: the list is long and most right-clicks are for
	// Done or Remind.
	const [isTagsOpen, setIsTagsOpen] = useState(false);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		const onDown = (event: MouseEvent) => {
			if (!ref.current?.contains(event.target as Node)) onClose();
		};
		window.addEventListener("keydown", onKey);
		// Defer: the same right-click that opened us would close us immediately.
		const timer = setTimeout(
			() => window.addEventListener("mousedown", onDown),
			0,
		);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("mousedown", onDown);
			clearTimeout(timer);
		};
	}, [onClose]);

	// Keep the menu on screen near the edges. Its height is measured, not
	// guessed: Tags opening adds the list and the New tag field, and the menu
	// moves up so they stay above the window's bottom. A fixed allowance left
	// them below it with nothing to scroll.
	const left = Math.min(x, window.innerWidth - 240);
	const [top, setTop] = useState(y);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const fit = () => setTop(menuTop(y, el.offsetHeight, window.innerHeight));
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(el);
		return () => observer.disconnect();
	}, [y]);

	return (
		<div
			ref={ref}
			data-session-menu
			style={{ left, top }}
			className="fixed z-[60] max-h-[calc(100vh-16px)] w-[220px] overflow-y-auto rounded-[10px] border border-border bg-card p-2 shadow-[0_10px_30px_rgba(0,0,0,.5)]"
		>
			<button
				type="button"
				onClick={() => {
					onStar();
					onClose();
				}}
				className="mb-1.5 flex w-full items-center gap-2 rounded-md border-b border-border px-1.5 pb-2 pt-1 text-left text-[12px] text-muted-foreground transition-colors hover:text-attention"
			>
				<span className="w-3 text-attention">★</span>
				{starred ? "Unstar" : "Star"}
			</button>
			<button
				type="button"
				onClick={() => {
					onDone();
					onClose();
				}}
				className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:text-success"
			>
				<span className="w-3 text-success">✓</span>
				Done
			</button>
			{onPark && (
				<button
					type="button"
					title="Park it in Idle - the session stays open, a running turn is stopped"
					onClick={() => {
						onPark();
						onClose();
					}}
					className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:text-foreground"
				>
					<LuPause className="size-3" aria-hidden />
					Move to Idle
				</button>
			)}
			{onDocs && (
				<button
					type="button"
					title="Move to Docs - off the board like Done, kept under Docs to read or bring back"
					onClick={() => {
						onDocs();
						onClose();
					}}
					className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:text-foreground"
				>
					<LuBookOpen className="size-3" aria-hidden />
					Move to Docs
				</button>
			)}
			{onRestart && (
				<button
					type="button"
					title="Quit Claude and reopen this conversation - picks up a new login or API key"
					onClick={() => {
						onRestart();
						onClose();
					}}
					className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:text-foreground"
				>
					<LuRotateCw className="size-3" aria-hidden />
					Restart session
				</button>
			)}
			{onRunHere && (
				<button
					type="button"
					title="Copy this conversation from the remote host and continue it on this computer"
					onClick={() => {
						onRunHere();
						onClose();
					}}
					className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:text-foreground"
				>
					<LuLaptop className="size-3" aria-hidden />
					Run on this computer
				</button>
			)}
			<div className="mb-1.5 border-b border-border pb-1.5">
				<RemindButton
					label="Remind me…"
					onPick={(day) => {
						onRemind(day);
						onClose();
					}}
					className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:text-attention"
				/>
				{watching !== undefined && (
					<button
						type="button"
						title="A notification whenever someone else replies in this session's Slack thread or Jira ticket, or its PR gets approved. Until then the card waits in Idle under Waiting on others"
						onClick={() => {
							onWatch();
							onClose();
						}}
						className={cn(
							"flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors hover:text-primary",
							watching ? "text-primary" : "text-muted-foreground",
						)}
					>
						<LuBellRing className="size-3" aria-hidden />
						{watching ? "Stop pinging me" : `Ping me on ${watchWhat}`}
					</button>
				)}
				{remote !== undefined && (
					<button
						type="button"
						title="Follow and answer this session from claude.ai/code or the Claude app"
						onClick={() => {
							onRemote();
							onClose();
						}}
						className={cn(
							"flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors hover:text-primary",
							remote ? "text-primary" : "text-muted-foreground",
						)}
					>
						<LuRadioTower className="size-3" aria-hidden />
						{remote ? "Turn off Remote Control" : "Turn on Remote Control"}
					</button>
				)}
				{onSaveDoc && (
					<button
						type="button"
						title="Ask the agent to save this session as a doc in ~/.odin/docs - pick it from Doc when you write a new task"
						onClick={() => {
							onSaveDoc();
							onClose();
						}}
						className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:text-primary"
					>
						<LuFileText className="size-3" aria-hidden />
						Save as doc
					</button>
				)}
			</div>
			{onKeep && (
				<button
					type="button"
					title="Overrule the sweep's Drop? - stays KEEP through later sweeps"
					onClick={() => {
						onKeep();
						onClose();
					}}
					className="mb-1.5 flex w-full items-center gap-2 rounded-md border-b border-border px-1.5 pb-2 pt-1 text-left text-[12px] text-muted-foreground transition-colors hover:text-success"
				>
					<span className="w-3 text-success">✓</span>
					Keep
				</button>
			)}
			<button
				type="button"
				aria-expanded={isTagsOpen}
				onClick={() => setIsTagsOpen(!isTagsOpen)}
				className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:text-foreground"
			>
				<span className="w-3">{isTagsOpen ? "▾" : "▸"}</span>
				Tags
				{tags.length > 0 && (
					<span className="min-w-0 flex-1 truncate text-right text-primary">
						{tags.map((tag) => `#${tag}`).join(" ")}
					</span>
				)}
			</button>
			{isTagsOpen && (
				<>
					<div className="flex max-h-[180px] flex-col overflow-y-auto">
						{[...allTags, ...customTags].map((tag) => {
							const on = tags.includes(tag);
							return (
								<div key={tag} className="group flex items-center">
									<button
										type="button"
										onClick={() => onToggle(tag)}
										className={cn(
											"flex flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors",
											on
												? "text-primary"
												: "text-muted-foreground hover:text-foreground",
										)}
									>
										<span className="w-3">{on ? "✓" : ""}</span>#{tag}
									</button>
									{customTags.includes(tag) && (
										<button
											type="button"
											title="Remove this tag from the list"
											onClick={() => onForget(tag)}
											className="px-1.5 text-[12px] text-faint-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
										>
											×
										</button>
									)}
								</div>
							);
						})}
					</div>
					<input
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Enter") return;
							onAdd(draft);
							setDraft("");
						}}
						placeholder="New tag…"
						className="mt-1.5 w-full rounded-md border border-border bg-transparent px-1.5 py-1 text-[12px] text-foreground outline-none placeholder:text-faint-foreground focus:border-primary"
					/>
				</>
			)}
		</div>
	);
}

/**
 * Stamp each card with the tags its brief came back with. The model picks
 * them while writing the brief that every card already gets, so this costs
 * no extra model call - it only carries the answer over to the pane.
 *
 * Once per card: your tags win afterwards, including the ones you removed.
 */
const applyAutoTags = (tagsBySession: Record<string, string[]>) => {
	const { sessionIdByPane } = usePaneMeta.getState();
	useTabsStore.setState((state) => {
		let changed = false;
		const panes = { ...state.panes };
		for (const [paneId, pane] of Object.entries(panes)) {
			if (pane.odinAutoTagged) continue;
			const sessionId = pane.claudeSessionId ?? sessionIdByPane[paneId];
			const auto = sessionId ? tagsBySession[sessionId] : undefined;
			if (!auto?.length) continue;
			panes[paneId] = {
				...pane,
				odinTags: [...new Set([...(pane.odinTags ?? []), ...auto])],
				odinAutoTagged: true,
			};
			changed = true;
		}
		return changed ? { panes } : {};
	});
};

/**
 * Rename cards from the brief the model wrote for them - on, that is, when the
 * setting is. One rename per session: the brief is rewritten as the session
 * works, and a card whose name shifts every five minutes is worse than one
 * named after the line you typed.
 */
const applyAutoTitles = (titlesBySession: Record<string, string>) => {
	const { sessionIdByPane } = usePaneMeta.getState();
	useTabsStore.setState((state) => {
		let changed = false;
		const panes = { ...state.panes };
		for (const [paneId, pane] of Object.entries(panes)) {
			if (pane.odinAutoTitled) continue;
			const sessionId = pane.claudeSessionId ?? sessionIdByPane[paneId];
			const title = sessionId ? titlesBySession[sessionId] : undefined;
			if (!title || title === pane.odinTaskTitle) continue;
			panes[paneId] = { ...pane, odinTaskTitle: title, odinAutoTitled: true };
			changed = true;
		}
		return changed ? { panes } : {};
	});
};

interface CardActions {
	openDrawer: (card: BoardCard) => void;
	setDragOverIdle: (over: boolean) => void;
	setTagMenu: (at: { paneId: string; x: number; y: number }) => void;
	toggleStar: (paneId: string) => void;
	markDone: (card: BoardCard) => void;
	remindMe: (card: BoardCard, day: string) => void;
	resumeCard: (card: BoardCard) => Promise<void>;
	cardTitle: (card: BoardCard) => string;
}

interface BoardCardTileProps {
	card: BoardCard;
	actions: CardActions;
	title: string;
	hoverText: string | null;
	contact: string | null;
	dropped: boolean;
	merged: boolean;
	ciChecks: string | undefined;
	conflicts: string | undefined;
	duplicate: BoardCard | undefined;
	since: number | undefined;
	focusedAt: number;
	customTags: string[];
	launchEmoji: string;
	isAgent: boolean;
	hostState: HostState;
	resuming: boolean;
	shellPane: Pane | undefined;
	shellAlive: boolean;
	hasDaemon: boolean;
}

/**
 * One board card. Memoized: the board re-renders on every poll, and redrawing
 * every card's pills and hover card each time kept the renderer busy while idle.
 * `card` is rebuilt whenever any pane changes, so it compares field by field.
 */
const BoardCardTile = memo(
	function BoardCardTile({
		card,
		actions,
		title,
		hoverText,
		contact,
		dropped,
		merged,
		ciChecks,
		conflicts,
		duplicate,
		since,
		focusedAt,
		customTags,
		launchEmoji,
		isAgent,
		hostState,
		resuming,
		shellPane,
		shellAlive,
		hasDaemon,
	}: BoardCardTileProps) {
		return (
			<HoverCard openDelay={1350}>
				<HoverCardTrigger asChild>
					{/* biome-ignore lint/a11y/useSemanticElements: a real <button> can't nest the reply <input>, so the card is a div with button semantics */}
					<div
						role="button"
						tabIndex={0}
						draggable
						onDragStart={(event) => {
							event.dataTransfer.setData("text/plain", card.pane.id);
							event.dataTransfer.effectAllowed = "move";
						}}
						onDragEnd={() => actions.setDragOverIdle(false)}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ") {
								actions.openDrawer(card);
							}
						}}
						onClick={() => actions.openDrawer(card)}
						onContextMenu={(event) => {
							// Right-click → done, remind, star or tag this session.
							event.preventDefault();
							actions.setTagMenu({
								paneId: card.pane.id,
								x: event.clientX,
								y: event.clientY,
							});
						}}
						className={cn(
							// A lit top edge, and a lift with a violet halo under the
							// pointer - the board's one bit of motion you cause. The
							// whole hover look (fill, violet edge, halo) is an ::after
							// that only fades in: background, border and shadow can't
							// animate on the compositor, so they repainted every frame
							// and stuttered whenever the board was busy rendering.
							"group relative isolate cursor-pointer rounded-[10px] border bg-card px-3 py-2.5 text-left shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] transition-[translate] duration-200 ease-out hover:-translate-y-px",
							"after:pointer-events-none after:absolute after:-inset-px after:-z-10 after:rounded-[inherit] after:border after:border-primary/40 after:bg-secondary after:opacity-0 after:shadow-[inset_0_1px_0_rgb(255_255_255/0.05),0_10px_24px_-12px_color-mix(in_oklab,var(--primary)_55%,transparent)] after:transition-opacity after:duration-200 after:ease-out hover:after:opacity-100",
							// Cards are neutral - the column header already says the
							// status. Only a failure earns its red edge.
							card.pane.status === "failed"
								? "border-danger/40"
								: "border-border",
						)}
					>
						<div className="flex items-start gap-2">
							<div className="min-w-0 flex-1 break-words text-[12.5px] font-semibold">
								<OverdueMark itemKey={`session:${card.pane.id}`} />
								<WatchMark paneId={card.pane.id} />
								<RemoteMark paneId={card.pane.id} />
								<HostMark paneId={card.pane.id} state={hostState} />
								{title}
							</div>
							<button
								type="button"
								title={
									card.pane.odinStarred ? "Unstar" : "Star - pin to the top"
								}
								aria-pressed={!!card.pane.odinStarred}
								onClick={(event) => {
									event.stopPropagation();
									actions.toggleStar(card.pane.id);
								}}
								className={cn(
									"shrink-0 rounded-[5px] px-1 text-[12px] text-attention transition-opacity hover:bg-attention/15",
									!card.pane.odinStarred && "opacity-0 group-hover:opacity-100",
								)}
							>
								{card.pane.odinStarred ? "★" : "☆"}
							</button>
							<button
								type="button"
								title="Done - remove from the board"
								onClick={(event) => {
									event.stopPropagation();
									actions.markDone(card);
								}}
								className={cn(
									"shrink-0 whitespace-nowrap",
									// Final review is where a card waits for you to close it,
									// so Done is the always-visible green pill there.
									card.status === "review"
										? `rounded-[7px] px-2.5 py-1 text-xs font-semibold transition-colors ${BUTTON.done}`
										: "rounded-[5px] px-1.5 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-success/15 hover:text-success group-hover:opacity-100",
								)}
							>
								✓ Done
							</button>
							<RemindButton
								onPick={(day) => actions.remindMe(card, day)}
								className="rounded-[5px] px-1.5 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-attention/15 hover:text-attention group-hover:opacity-100"
							/>
						</div>
						<WatchReply paneId={card.pane.id} />
						{/* Facts are one grey text line; chips are left only for flags that ask
    something of you. A pill that renders nothing drops out, so the dots
    between the rest stay right. */}
						<div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11.5px] text-muted-foreground [&>*+*]:before:inline-block [&>*+*]:before:mr-1.5 [&>*+*]:before:text-faint-foreground [&>*+*]:before:content-['·']">
							{(dropped || merged) && (
								<span className="font-medium text-danger">
									{merged ? "Dropped: PR merged" : "Dropped: PR closed"}
								</span>
							)}
							{contact && (
								<span className="inline-flex min-w-0 items-center gap-1 font-medium text-soft-foreground">
									<span
										className="size-1.5 shrink-0 rounded-full"
										style={{
											backgroundColor: personColor(contact as string).fg,
										}}
									/>
									<span className="truncate">{contact}</span>
								</span>
							)}
							<RepoPill card={card} />
							<PrPill card={card} live={card.status === "working"} />
							{!!ciChecks && (
								<span
									title={`CI running: ${ciChecks}`}
									className="inline-flex items-center gap-1 font-medium text-working"
								>
									<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-working" />
									CI running
								</span>
							)}
							{!!conflicts && (
								<span title={conflicts} className="font-medium text-attention">
									Merge conflicts
								</span>
							)}
							<NotionPill card={card} live={card.status === "working"} />
							<AgePill
								card={card}
								live={card.status === "working"}
								fallback={since}
							/>
						</div>
						<DropPill pane={card.pane} />
						<DuplicateHint other={duplicate} titleOf={actions.cardTitle} />
						<div className="mt-1 flex flex-wrap items-center gap-1.5">
							<ReviewPill card={card} />
							<MergeOnlyPill card={card} />
							{(card.status === "review" || card.status === "permission") && (
								<JustDonePill focusedAt={focusedAt} since={since} />
							)}
							{boardTags(card.pane.odinTags, customTags).some(
								(tag) => !PILL_TAGS.includes(tag),
							) && (
								<span className="font-mono text-[10.5px] text-faint-foreground">
									{boardTags(card.pane.odinTags, customTags)
										.filter((tag) => !PILL_TAGS.includes(tag))
										.map((tag) => `#${tag}`)
										.join(" ")}
								</span>
							)}
							{boardTags(card.pane.odinTags, customTags).includes(
								"automation",
							) && (
								// Violet and a clock, the pair the Tasks list gives a scheduled row:
								// the one tag that answers "who started this?" on a board you
								// otherwise started yourself.
								<span
									title="Started by a schedule, not by you"
									className={cn(
										"inline-flex items-center gap-1 rounded-[5px] px-[7px] text-[11px] font-medium",
										PILL.brand,
									)}
								>
									<LuClock className="size-3" />
									Automation
								</span>
							)}
							{card.pane.odinTags?.includes("off-hours") && (
								// Violet and a moon: the overnight run's work,
								// picked out from a board you otherwise started yourself.
								<span
									title="Started overnight by Night Agent, while you were away"
									className={cn(
										"inline-flex items-center gap-1 rounded-[5px] px-[7px] text-[11px] font-medium",
										PILL.brand,
									)}
								>
									<LuMoon className="size-3" />
									Night Agent
								</span>
							)}
							{card.pane.odinTags?.includes("auto-started") && (
								<span
									title="Started by your Slack reaction, not a click"
									className={cn(
										"inline-flex items-center gap-1 rounded-[5px] px-[7px] text-[11px] font-medium",
										PILL.brand,
									)}
								>
									{launchEmoji} Auto-started
								</span>
							)}
							{isAgent && <LoopPill card={card} />}
							<LoadPill card={card} />
							{shellPane && hasDaemon && (
								<ShellChip
									shellPaneId={shellPane?.id ?? ""}
									alive={shellAlive}
								/>
							)}
							{/* Last, and blank until you set one: a deadline is yours, not
	    something the session reports about itself. */}
							<DueChip itemKey={`session:${card.pane.id}`} title={title} />
						</div>
						{card.status === "working" && (
							<div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
								<span
									className="size-[9px] animate-spin rounded-full border"
									style={{
										borderColor: PANE_STATUS.working.dot,
										borderTopColor: "transparent",
									}}
								/>
								agent running
							</div>
						)}
						{card.status === "permission" && card.pane.status === "failed" && (
							<div className="mt-1.5 text-xs text-danger">
								✗ failed - click to see what broke
							</div>
						)}
						{card.status === "idle" && !isAgent && resuming && (
							<div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-working">
								<span className="size-[9px] animate-spin rounded-full border border-working border-t-transparent" />
								{card.pane.odinQueued ? "starting…" : "resuming…"}
							</div>
						)}
						{/* Never started - it's waiting on the machine, not
					    on you. Says what for, and lets you overrule it. */}
						{card.pane.odinQueued && !resuming && (
							<div className="mt-1.5 flex items-center gap-2">
								<span className="text-[11.5px] text-attention">
									⏳ {card.pane.odinQueued.reason}
								</span>
								{/* The host's gate is never overruled - too many sessions there
								    take every one down - but a new task can go to this Mac. */}
								{(!card.pane.odinQueued.remote ||
									card.pane.odinQueued.remote.prompt) && (
									<button
										type="button"
										title={
											card.pane.odinQueued.remote
												? "Start this session on this Mac instead of the remote host"
												: "Start this session now, gate or no gate"
										}
										onClick={(event) => {
											event.stopPropagation();
											void actions.resumeCard(card);
										}}
										className={cn(
											"ml-auto shrink-0 whitespace-nowrap rounded-[7px] px-2.5 py-1 text-xs font-semibold",
											BUTTON.secondary,
										)}
									>
										{card.pane.odinQueued.remote
											? "Start on this Mac"
											: "Start now"}
									</button>
								)}
							</div>
						)}
						{card.status === "idle" &&
							!card.pane.odinQueued &&
							!isAgent &&
							!resuming && (
								<div className="mt-1.5 flex items-center gap-2">
									{card.pane.status === "failed" && (
										<span className="text-[11.5px] text-danger">✗ failed</span>
									)}
									{/* Resume does more here than on the other
							    cards - it puts the agent back to work
							    instead of handing you a prompt. */}
									{card.pane.status === "working" && (
										<span className="text-[11.5px] text-attention">
											⏸ died mid-turn
										</span>
									)}
									{card.pane.status !== "working" &&
										card.pane.odinExitCause && (
											<span className="select-text cursor-text truncate text-[11.5px] text-danger">
												✗ {card.pane.odinExitCause}
											</span>
										)}
									<button
										type="button"
										onClick={(event) => {
											event.stopPropagation();
											void actions.resumeCard(card);
										}}
										className={cn(
											"rounded-[7px] px-2.5 py-1 text-xs font-semibold",
											BUTTON.secondary,
										)}
									>
										Resume
									</button>
								</div>
							)}
					</div>
				</HoverCardTrigger>
				<HoverCardContent
					side="right"
					align="start"
					className="max-h-[70vh] w-[400px] overflow-y-auto border-input bg-secondary p-3 shadow-[0_12px_40px_rgba(0,0,0,0.75)]"
				>
					<CardHoverContent card={card} text={hoverText} />
				</HoverCardContent>
			</HoverCard>
		);
	},
	(prev, next) =>
		(Object.keys(next) as (keyof BoardCardTileProps)[]).every((key) =>
			key === "card"
				? shallowEqual(prev.card, next.card)
				: prev[key] === next[key],
		),
);

function shallowEqual<T extends object>(a: T, b: T): boolean {
	return (Object.keys(b) as (keyof T)[]).every((key) => a[key] === b[key]);
}

/**
 * Re-render on an answer, not on every poll starting and stopping. The settle
 * check reads `fetchStatus`, which subscribes the board to it: with ~30 of these
 * queries on 60s timers, that alone re-rendered the whole board about once a
 * second.
 */
const QUIET_POLL: ("data" | "error")[] = ["data", "error"];

function DevBoardPage() {
	// The Auto-started pill wears whichever emoji you set to auto-start.
	const launchEmoji = emojify(
		`:${useOdinFeeds().reactions.data?.launchReaction ?? "robot_face"}:`,
	);
	const tabs = useTabsStore((state) => state.tabs);
	const panes = useTabsStore((state) => state.panes);
	// No workspace picker - one workspace in practice, and it listed confusing
	// duplicate "default" entries. ensureWorkspace still provisions/resolves the
	// workspace sessions launch into, and `workspaces` labels cards with their
	// workspace name.
	const { workspaces, ensureWorkspace } = useOdinWorkspace();
	// Sessions belong to the profile they were started under; the others stay
	// alive in their panes, they just aren't this board's business.
	const { activeId: activeProfileId, isLoading: isProfileLoading } =
		useOdinProfile();
	const { launch, isLaunching } = useLaunchTaskSession();
	const utils = electronTrpc.useUtils();
	const { data: workConfig } = electronTrpc.work.getConfig.useQuery();
	// An <a> would navigate the app window; the ticket opens in a browser.
	const contactByPane = usePaneMeta((s) => s.contactByPane);
	const titleByPane = usePaneMeta((s) => s.titleByPane);
	const briefByPane = usePaneMeta((s) => s.briefByPane);
	// Same query (and cache) as the Slack view, so this reads, not re-polls.
	const { data: slackFeed } = electronTrpc.slack.reactions.useQuery(undefined, {
		staleTime: 120_000,
		refetchOnMount: false,
	});
	const slackTextById = useMemo(
		() => new Map((slackFeed?.rows ?? []).map((row) => [row.id, row.text])),
		[slackFeed],
	);
	// Prefer the task title captured at launch - Claude Code's OSC title rewrites
	// the pane name to "Claude Code" once it starts.
	// `panes` first: the drawer holds a snapshot card, so a rename has to be read
	// from the live pane or the drawer keeps showing the old name.
	// A Slack card launched with only the cut title as its brief still has its
	// whole message in the feed.
	const cardSource = (card: BoardCard) =>
		(card.pane.odinPageId && slackTextById.get(card.pane.odinPageId)) ||
		(card.pane.odinBrief ?? briefByPane[card.pane.id] ?? null);
	const cardTitle = (card: BoardCard) =>
		emojify(
			untruncatedTitle(
				panes[card.pane.id]?.odinTaskTitle ??
					card.pane.odinTaskTitle ??
					titleByPane[card.pane.id] ??
					card.pane.userTitle ??
					card.pane.name ??
					card.tabName,
				cardSource(card),
			),
		);
	// The full message behind an auto-renamed (or first-line) title - hover only.
	const cardText = (card: BoardCard) => {
		const body = cardBody(cardTitle(card), cardSource(card));
		return body && emojify(body);
	};
	// Point of contact: the pane's own record (shared app-state) first, then the
	// legacy localStorage mirror for panes launched before that existed.
	const cardContact = (card: BoardCard) =>
		card.pane.odinContact ?? contactByPane[card.pane.id] ?? null;

	const [isComposerOpen, setIsComposerOpen] = useState(false);
	const [composerRepo, setComposerRepo] = useState("");
	// A card whose conversation Claude no longer has. Resume stops and puts this
	// here; the dialog it opens asks whether to start over from the card's brief.
	const [lostCard, setLostCard] = useState<BoardCard | null>(null);
	const [drawerCard, setDrawerCard] = useState<BoardCard | null>(null);
	// Ticked rows in the drawer's session list, for acting on many at once -
	// resuming a dozen Idle sessions was a dozen Resume clicks. Only rows still
	// on screen count: folding Idle, or a session ending, takes its tick out
	// of the next action. The count is a ref for the Esc listener below.
	const [pickedIds, setPickedIds] = useState<Set<string>>(() => new Set());
	const [pickAnchor, setPickAnchor] = useState<string | null>(null);
	const pickedCountRef = useRef(0);
	// Select mode: the list's Select button puts a tick box on every row and
	// a row click ticks it. Off, the rows show their status dots only.
	const [selecting, setSelecting] = useState(false);
	const selectingRef = useRef(false);
	selectingRef.current = selecting;
	useEffect(() => {
		if (!drawerCard) {
			setPickedIds(new Set());
			setSelecting(false);
		}
	}, [drawerCard]);
	// Catch up (Slack mobile's): Needs you one card at a time in the drawer.
	// The pane ids are a snapshot taken on start, so ✓ done doesn't reshuffle
	// the cards you haven't reached.
	const [catchUp, setCatchUp] = useState<string[] | null>(null);
	// Catch up lasts as long as its drawer. Only ‹ and "All caught up" used to
	// end it, so a click outside, Esc or Minimize left the queue behind - and
	// opening one of its cards from the board later came up as Catch up.
	useEffect(() => {
		if (!drawerCard) setCatchUp(null);
	}, [drawerCard]);
	// Catch up shows a card's full session only after you ask, per card - a pane
	// id, so the next card starts lean again without an effect to reset it.
	const [catchUpFull, setCatchUpFull] = useState<string | null>(null);
	// Rename a session. Same home as tags (the pane, in app-state.json) and the
	// first thing cardTitle reads, so the new name shows everywhere and sticks.
	// Non-null = the drawer's title is being edited.
	const [renameDraft, setRenameDraft] = useState<string | null>(null);
	// The ticket (or PR) this session was launched from - the drawer's title says
	// "CRR-862: …" and until now there was no way to open CRR-862.
	const drawerLink = drawerCard ? sourceLink(drawerCard.pane.odinBrief) : null;
	// Open wide by default - a session needs room to read the terminal. Held as
	// a fraction of the width beside the icon rail, not px: a px width measured
	// once went stale when the window was minimized/resized, and the drawer
	// stopped short of the rail or overran it.
	const [drawerFraction, setDrawerFraction] = useState(1);
	// The brief panel: open by default, because "what did I walk into?" is the
	// question you have every single time you open a session.
	const [isBriefOpen, setIsBriefOpen] = useState(true);
	// The diff takes the terminal's place rather than a side panel - a diff needs
	// the width, and you read one instead of watching the session, not alongside.
	const [isDiffOpen, setIsDiffOpen] = useState(false);
	// A plain shell in the session's checkout. Takes the terminal's place for the
	// same reason the diff does - you go to the shell instead of the session.
	const [isShellOpen, setIsShellOpen] = useState(false);
	/** Which of the session's Shells the drawer shows: a name, or null for the main one. */
	const [shellName, setShellName] = useState<string | null>(null);
	const chatView = useSessionView((s) => s.chat);
	const setChatView = useSessionView((s) => s.setChat);
	// The chat can't answer a TUI menu; this pane's drawer shows the terminal
	// until you go back to the chat.
	const [terminalPaneId, setTerminalPaneId] = useState<string | null>(null);
	// Panes whose Resume is in flight. Resuming takes a second (session lookup,
	// kill, respawn) and the card can't flip out of Idle until the 5s daemon
	// poll sees the new PTY - without this the click looks like it did nothing.
	const [resumingPaneIds, setResumingPaneIds] = useState<string[]>([]);

	const startDrawerResize = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const onMove = (move: PointerEvent) => {
			const available = window.innerWidth - RAIL_W;
			const width = window.innerWidth - move.clientX;
			setDrawerFraction(Math.min(Math.max(width / available, 0), 1));
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	// The cached xterm can mount into the drawer with stale dimensions (its
	// gated refit can miss), clipping the bottom of the screen - where Claude
	// renders its pickers. Nudge it: refit, sync the PTY size (SIGWINCH makes
	// Claude repaint at the new size), and pin the view to the bottom.
	// Switching from chat view to the terminal is the worst case: a remote
	// session is driven over chat, so its PTY sat at the 80x24 spawn default
	// the whole time, and the terminal first mounts (stale) only on this
	// switch - so terminalPaneId and chatView are triggers too, without them
	// the terminal opens at 80 columns and Claude's TUI wraps.
	// biome-ignore lint/correctness/useExhaustiveDependencies: isBriefOpen, terminalPaneId and chatView are triggers - each changes the terminal's size
	useEffect(() => {
		if (!drawerCard || drawerCard.pane.type !== "terminal") return;
		const paneId = drawerCard.pane.id;
		const nudge = () => {
			const entry = terminalCache.get(paneId);
			if (!entry) return;
			try {
				entry.fitAddon.fit();
				utils.client.terminal.resize.mutate({
					paneId,
					cols: entry.xterm.cols,
					rows: entry.xterm.rows,
				});
				entry.xterm.scrollToBottom();
			} catch {
				// cosmetic nudge only
			}
		};
		// The short one is for the brief toggling: it takes 340px off the terminal
		// (or gives them back), and without a refit Claude keeps painting its TUI
		// at the old width.
		const timers = [
			setTimeout(nudge, 120),
			setTimeout(nudge, 1200),
			setTimeout(nudge, 3500),
		];
		return () => {
			for (const timer of timers) clearTimeout(timer);
		};
	}, [drawerCard, utils, isBriefOpen, terminalPaneId, chatView]);

	// Esc closes the drawer. Captured at the window so it doesn't reach the
	// terminal by default - an Esc in the PTY cancels Claude's pending menu and
	// trips upstream's "user interrupted → idle" status heuristic. The
	// exceptions below are the states where Esc already means something to
	// whatever is on screen, and there it's handed back.
	useEffect(() => {
		if (!drawerCard) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// A link open over the drawer takes this Esc and closes alone.
			if (useInAppBrowser.getState().url) return;
			// Huginn open over the drawer closes first, on its own listener.
			if (document.querySelector("[data-crow-panel]")) return;
			// A box opened over the pane cancels itself on Esc. Captured this
			// early we'd swallow that keypress and close the drawer out from
			// under it instead, so hand the key back and leave the drawer alone.
			if ((event.target as HTMLElement | null)?.closest("[role=dialog]"))
				return;
			// Same rule for Claude's own menus: standing in a picker that says
			// "Esc to go back", Esc belongs to the picker, not to the drawer.
			// Read the mounted xterm rather than the scan's cached status - the
			// scan runs on a 3s timer and a menu opens and closes inside that.
			if (
				event.target instanceof HTMLElement &&
				event.target.closest(".xterm") &&
				escIsHandledOnScreen(visibleScreen(drawerCard.pane.id))
			)
				return;
			event.preventDefault();
			event.stopImmediatePropagation();
			// Selecting in the session list: Esc leaves select mode, not the drawer.
			if (pickedCountRef.current || selectingRef.current) {
				setPickedIds(new Set());
				setSelecting(false);
			}
			// Mid-rename, Esc abandons the rename - not the drawer.
			else if (renameDraft !== null) setRenameDraft(null);
			else setDrawerCard(null);
		};
		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () =>
			window.removeEventListener("keydown", onKeyDown, { capture: true });
	}, [drawerCard, renameDraft]);

	const focusedAt = useFocusedAt();
	const statusSinceRef = useRef(
		new Map<string, { status: PaneStatus; at: number }>(),
	);
	// Statuses already on the panes when the board mounted came off disk: the
	// hooks that wrote them belong to a previous run of the renderer, so they've
	// been held for an unknown time, not for zero seconds. Stamp those "settled"
	// (at: 0) so the screen scan may correct a restored status on its first pass
	// rather than waiting out SETTLED_MS for a hook race that can't happen yet.
	// Panes that appear later are freshly launched and do get the full grace.
	const restoredRef = useRef(true);
	useEffect(() => {
		const map = statusSinceRef.current;
		const restored = restoredRef.current;
		restoredRef.current = false;
		for (const pane of Object.values(panes)) {
			const status = pane.status ?? "idle";
			const entry = map.get(pane.id);
			if (!entry || entry.status !== status) {
				map.set(pane.id, { status, at: restored ? 0 : Date.now() });
			}
		}
	}, [panes]);

	// A parked session that started moving again isn't parked any more - drop the
	// flag so its next finished turn lands in Needs you, not back in Idle.
	useEffect(() => {
		const revived = Object.values(panes).filter(
			(pane) => pane.odinParked && (pane.status ?? "idle") !== "idle",
		);
		if (revived.length === 0) return;
		useTabsStore.setState((state) => {
			const next = { ...state.panes };
			for (const pane of revived)
				next[pane.id] = { ...next[pane.id], odinParked: false };
			return { panes: next };
		});
	}, [panes]);

	const workspaceById = useMemo(() => {
		const map = new Map<string, SelectWorkspace>();
		for (const workspace of workspaces) map.set(workspace.id, workspace);
		return map;
	}, [workspaces]);

	// Workspaces only carry their own name ("default" for the one Odin
	// provisions), so the repo chip needs the project behind them for its path.
	const { data: projects = [] } = electronTrpc.projects.getRecents.useQuery();
	const projectById = useMemo(() => {
		const map = new Map<string, SelectProject>();
		for (const project of projects) map.set(project.id, project);
		return map;
	}, [projects]);

	// Live PTYs in the daemon - lets the board show sessions that survived an
	// app reload even though their pane status was reset to idle.
	const { data: daemonSessions } =
		electronTrpc.terminal.listDaemonSessions.useQuery(undefined, {
			refetchInterval: 5_000,
		});
	const alivePaneIds = useMemo(
		() =>
			new Set(
				(daemonSessions?.sessions ?? [])
					.filter((session) => session.isAlive)
					.map((session) => session.sessionId),
			),
		[daemonSessions],
	);
	// A just-launched session turns "working" before the next 5s poll lists its
	// PTY, and "working" with no PTY is exactly what "⏸ died mid-turn" means.
	// Ask the daemon again the moment one shows up instead of waiting it out.
	const unlistedWorking = Object.values(panes)
		.filter((pane) => pane.status === "working" && !alivePaneIds.has(pane.id))
		.map((pane) => pane.id)
		.sort()
		.join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: the id list is the trigger
	useEffect(() => {
		if (unlistedWorking && daemonSessions)
			void utils.terminal.listDaemonSessions.invalidate();
	}, [unlistedWorking]);
	// Panes whose PTY is alive but has no agent in it - Ctrl+C out of Claude and
	// the shell outlives the conversation. Filled in by the screen scan below.
	const [agentGonePaneIds, setAgentGonePaneIds] = useState<string[]>([]);
	/**
	 * PTY alive AND Claude still running in it. This - not the raw daemon poll -
	 * is what "the session is open" means to a card: everything a live pane is
	 * offered (Continue, its column, no Resume button) assumes there's a
	 * conversation on the other end, and a bare shell prompt is not one.
	 */
	const agentPaneIds = useMemo(
		() =>
			new Set([...alivePaneIds].filter((id) => !agentGonePaneIds.includes(id))),
		[alivePaneIds, agentGonePaneIds],
	);
	// Remote panes still reaching their host, or whose connect failed, read off
	// their screens. Not left to the status scan below: it waits SETTLED_MS
	// after a change, and a connect is over in 10-30s.
	const [connectStates, setConnectStates] = useState<Record<string, HostState>>(
		{},
	);
	const remotePaneIds = Object.values(panes)
		.filter((pane) => pane.odinRemote && alivePaneIds.has(pane.id))
		.map((pane) => pane.id)
		.sort()
		.join(",");
	useEffect(() => {
		if (!remotePaneIds) return setConnectStates({});
		let stopped = false;
		const check = async () => {
			const states = await Promise.all(
				remotePaneIds.split(",").map(async (paneId) => {
					const screen =
						visibleScreen(paneId) ||
						((await electronTrpcClient.terminal.readScreen
							.query({ paneId })
							.then((result) => result.text)
							.catch(() => null)) ??
							"");
					return [paneId, connectStateOf(screen)] as const;
				}),
			);
			if (stopped) return;
			const next = Object.fromEntries(states) as Record<string, HostState>;
			setConnectStates((prev) =>
				JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
			);
		};
		void check();
		const id = setInterval(() => void check(), 2_000);
		return () => {
			stopped = true;
			clearInterval(id);
		};
	}, [remotePaneIds]);
	// Yellow until a screen read says otherwise: green before the first read
	// flashed on every Restart. Red only once the daemon says the pane is gone.
	const hostStateOf = (paneId: string): HostState =>
		connectStates[paneId] ??
		(alivePaneIds.has(paneId) || !daemonSessions ? "connecting" : "off");
	// Sessions under `/loop`, read from the same transcript query the loop pill
	// uses, so it's one fetch per session. Between ticks they belong in Idle -
	// every turn ends clean, but they aren't done.
	const sessionIdByPane = usePaneMeta((s) => s.sessionIdByPane);
	const loopCandidates = [...agentPaneIds].flatMap((paneId) => {
		const sessionId = panes[paneId]?.claudeSessionId ?? sessionIdByPane[paneId];
		return sessionId ? [{ paneId, sessionId }] : [];
	});
	const loopQueries = electronTrpc.useQueries((t) =>
		loopCandidates.map(({ sessionId }) =>
			t.terminal.readClaudeTranscript(
				{ sessionId },
				{
					retry: false,
					staleTime: 60_000,
					refetchInterval: 60_000,
					notifyOnChangeProps: QUIET_POLL,
				},
			),
		),
	);
	const loopingKey = loopCandidates
		.filter((_, i) => loopQueries[i]?.data?.loop)
		.map(({ paneId }) => paneId)
		.join(",");
	const loopingPaneIds = useMemo(
		() => new Set(loopingKey ? loopingKey.split(",") : []),
		[loopingKey],
	);
	// Sessions whose Claude ended with a `/loop` still armed. The loop lived in
	// that process (gone with a daemon or app restart, or a crash); `--resume`
	// books it again, so reopening the session keeps the schedule running.
	const deadLoopCandidates = Object.values(panes).flatMap((pane) => {
		if (
			agentPaneIds.has(pane.id) ||
			pane.completed ||
			pane.odinQueued ||
			!pane.odinTaskTitle
		)
			return [];
		const sessionId = pane.claudeSessionId ?? sessionIdByPane[pane.id];
		return sessionId ? [{ paneId: pane.id, sessionId }] : [];
	});
	const deadLoopQueries = electronTrpc.useQueries((t) =>
		deadLoopCandidates.map(({ sessionId }) =>
			t.terminal.claudeLoop(
				{ sessionId },
				{
					retry: false,
					staleTime: 5 * 60_000,
					refetchInterval: 5 * 60_000,
					notifyOnChangeProps: QUIET_POLL,
				},
			),
		),
	);
	const deadLoopKey = deadLoopCandidates
		.filter((_, i) => deadLoopQueries[i]?.data?.kind === "cron")
		.map(({ paneId }) => paneId)
		.join(",");
	const deadLoopPaneIds = useMemo(
		() => new Set(deadLoopKey ? deadLoopKey.split(",") : []),
		[deadLoopKey],
	);
	// Needs-you and Done sessions, open or closed, and the state of every PR
	// they linked. Once each is approved a Needs you card is Done: what's left is
	// a click, not a decision. While CI still runs on one, either card is
	// Working. Closed ones count - the approval usually lands after the session
	// went quiet, and a card closed for idling keeps its column. The
	// transcripts are the ones the cards' own pills already fetch.
	// Each brief's URGENCY and the reply it judged, by session id - comes back
	// with every brief warm (below), so no call of its own.
	const [briefUrgency, setBriefUrgency] = useState<
		Record<string, { urgency: BriefUrgency; replyAt: string }>
	>({});
	const mergeCandidates = Object.values(panes).flatMap((pane) => {
		const sessionId = pane.claudeSessionId ?? sessionIdByPane[pane.id];
		if (
			!sessionId ||
			(!pane.odinTaskTitle && !titleByPane[pane.id]) ||
			profileOf(pane.odinProfile) !== activeProfileId
		)
			return [];
		const alive =
			daemonSessions === undefined ? undefined : agentPaneIds.has(pane.id);
		const column = boardColumn(
			pane.status ?? "idle",
			alive,
			pane.odinParked ?? false,
			loopingPaneIds.has(pane.id),
			pane.odinClosedIn,
		);
		return column === "permission" || column === "review"
			? [
					{
						paneId: pane.id,
						sessionId,
						live: !!alive,
						brief: pane.odinBrief,
						column,
					},
				]
			: [];
	});
	const mergeTranscripts = electronTrpc.useQueries((t) =>
		mergeCandidates.map(({ sessionId, live }) =>
			t.terminal.readClaudeTranscript(
				{ sessionId },
				{
					retry: false,
					staleTime: 60_000,
					refetchInterval: live ? 60_000 : false,
					notifyOnChangeProps: QUIET_POLL,
				},
			),
		),
	);
	const mergeStateQueries = electronTrpc.useQueries((t) =>
		mergeCandidates.map(({ brief }, i) => {
			const messages = mergeTranscripts[i]?.data?.messages ?? [];
			const reviewed = reviewedPullRequest(brief, messages);
			const urls = mergeCheckUrls(messages);
			if (reviewed && !urls.includes(reviewed.url)) urls.push(reviewed.url);
			return t.terminal.pullRequestStates(
				{ urls },
				{
					enabled: urls.length > 0,
					retry: false,
					staleTime: 30_000,
					refetchInterval: 60_000,
					notifyOnChangeProps: QUIET_POLL,
				},
			);
		}),
	);
	// Needs you cards only, unless `anyColumn`: Done ones are here for CI.
	const candidateKey = (
		test: (
			messages: BriefMessage[],
			states: Parameters<typeof mergeReady>[1] | undefined,
			brief: string | null | undefined,
			candidate: (typeof mergeCandidates)[number],
		) => boolean,
		anyColumn = false,
	) =>
		mergeCandidates
			.filter((candidate, i) => {
				if (!anyColumn && candidate.column !== "permission") return false;
				const messages = mergeTranscripts[i]?.data?.messages;
				return (
					!!messages &&
					test(
						messages,
						claimOpened(messages, mergeStateQueries[i]?.data),
						candidate.brief,
						candidate,
					)
				);
			})
			.map(({ paneId }) => paneId)
			.join(",");
	/**
	 * Nothing left, or all that's left is a click on what shipped: Done,
	 * whatever the column says.
	 */
	const finishedBarAClick = (
		messages: BriefMessage[],
		states: Parameters<typeof mergeReady>[1] | undefined,
		brief: string | null | undefined,
	) =>
		nothingLeft(messages) ||
		onlyLookLeft(messages) ||
		(!!states &&
			(mergeReady(messages, states) ||
				prsDropped(messages, states) ||
				!!reviewEnded(reviewedPullRequest(brief, messages), states)));
	const mergeReadyKey = candidateKey(finishedBarAClick);
	// The brief's URGENCY per pane, while it judged the reply that's still the
	// latest - a stale one says nothing about what the session wants now.
	const urgencyKey = mergeCandidates
		.map(({ paneId, sessionId }, i) => {
			const judged = briefUrgency[sessionId];
			const messages = mergeTranscripts[i]?.data?.messages;
			return judged &&
				messages &&
				sameReply(latestReply(messages)?.at, judged.replyAt)
				? `${paneId}:${judged.urgency}`
				: "";
		})
		.filter(Boolean)
		.join(",");
	const urgencyByPane = useMemo(
		() =>
			new Map(
				urgencyKey
					? urgencyKey.split(",").map((entry) => {
							const [paneId = "", urgency] = entry.split(":");
							return [paneId, urgency as BriefUrgency];
						})
					: [],
			),
		[urgencyKey],
	);
	// Done cards whose latest reply asks you something: the Stop hook calls
	// every unwatched turn end Done, so a question at the end of one landed
	// there. Not when all that's left is a click - that stays Done.
	const briefAsksKey = candidateKey(
		(messages, states, brief, { paneId, column }) =>
			column === "review" &&
			urgencyByPane.get(paneId) === "needs-you" &&
			!finishedBarAClick(messages, states, brief),
		true,
	);
	const briefAsksPaneIds = useMemo(
		() => new Set(briefAsksKey ? briefAsksKey.split(",") : []),
		[briefAsksKey],
	);
	const droppedKey = candidateKey(
		(messages, states, brief) =>
			!!states &&
			(prsDropped(messages, states) ||
				reviewEnded(reviewedPullRequest(brief, messages), states) === "CLOSED"),
	);
	const reviewMergedKey = candidateKey(
		(messages, states, brief) =>
			!!states &&
			reviewEnded(reviewedPullRequest(brief, messages), states) === "MERGED",
	);
	const reviewMergedPaneIds = useMemo(
		() => new Set(reviewMergedKey ? reviewMergedKey.split(",") : []),
		[reviewMergedKey],
	);
	const mergeReadyPaneIds = useMemo(
		() => new Set(mergeReadyKey ? mergeReadyKey.split(",") : []),
		[mergeReadyKey],
	);
	// pane id -> the checks still running on its PRs. Keyed by a string so the
	// map only changes when a check starts or ends.
	const ciKey = mergeCandidates
		.map(({ paneId }, i) => {
			const states = claimOpened(
				mergeTranscripts[i]?.data?.messages ?? [],
				mergeStateQueries[i]?.data,
			);
			const checks = states ? ciRunning(states) : [];
			return checks.length ? `${paneId}\t${checks.join("\t")}` : "";
		})
		.filter(Boolean)
		.join("\n");
	const ciChecksByPane = useMemo(
		() =>
			new Map(
				ciKey
					? ciKey.split("\n").map((line) => {
							const [paneId = "", ...checks] = line.split("\t");
							return [paneId, checks];
						})
					: [],
			),
		[ciKey],
	);
	// pane id -> "PR #N has merge conflicts with main" lines, one string per
	// pane so a card only re-renders when its PRs' conflicts change.
	const conflictsByPane = new Map(
		mergeCandidates.flatMap(({ paneId }, i) => {
			const states = claimOpened(
				mergeTranscripts[i]?.data?.messages ?? [],
				mergeStateQueries[i]?.data,
			);
			const lines = states ? mergeConflicts(states) : [];
			return lines.length ? [[paneId, lines.join("\n")] as const] : [];
		}),
	);
	const droppedPaneIds = useMemo(
		() => new Set(droppedKey ? droppedKey.split(",") : []),
		[droppedKey],
	);
	/**
	 * Needs you or Done, but Working while CI runs on one of its PRs: the
	 * session is waiting on CI, not on you. Otherwise Needs you, unless all it
	 * needs is merging approved PRs or a look at what shipped, or its PRs were
	 * closed - then Done.
	 */
	// "Ping me" sessions, as "<paneId>\t<1 if a reply is unread>" lines - a
	// string, so the cards below only regroup when one actually changes.
	const watchKey = useReplyWatch((s) =>
		[
			...new Set(
				Object.values(s.watches).flatMap((w) =>
					w.paneId ? [`${w.paneId}\t${w.reply ? 1 : 0}`] : [],
				),
			),
		]
			.sort()
			.join("\n"),
	);
	const watchByPane = useMemo(() => {
		const byPane = new Map<string, "waiting" | "replied">();
		for (const line of watchKey ? watchKey.split("\n") : []) {
			const [paneId = "", unread] = line.split("\t");
			if (unread === "1" || !byPane.has(paneId))
				byPane.set(paneId, unread === "1" ? "replied" : "waiting");
		}
		return byPane;
	}, [watchKey]);
	const withMergeReady = useCallback(
		(column: PaneStatus, paneId: string): PaneStatus =>
			(column === "permission" || column === "review") &&
			ciChecksByPane.has(paneId)
				? "working"
				: column === "permission" && mergeReadyPaneIds.has(paneId)
					? "review"
					: column === "review" && briefAsksPaneIds.has(paneId)
						? "permission"
						: column,
		[mergeReadyPaneIds, ciChecksByPane, briefAsksPaneIds],
	);
	// A reload paints cards before the daemon poll, transcripts and PR states
	// answer, so they hop columns for a second. Hold a spinner until those
	// first answers land, then never again. A disabled query (no PR urls)
	// counts as answered.
	const isAnswered = (query: { isFetched: boolean; fetchStatus: string }) =>
		query.isFetched || query.fetchStatus === "idle";
	const firstAnswersIn =
		!isProfileLoading &&
		daemonSessions !== undefined &&
		[...loopQueries, ...mergeTranscripts, ...mergeStateQueries].every(
			isAnswered,
		);
	const [isBoardSettled, setIsBoardSettled] = useState(false);
	useEffect(() => {
		if (isBoardSettled) return;
		if (firstAnswersIn) return setIsBoardSettled(true);
		const timer = setTimeout(() => setIsBoardSettled(true), 4_000);
		return () => clearTimeout(timer);
	}, [firstAnswersIn, isBoardSettled]);
	/**
	 * Live Claude that's been up a while. Continue is for nudging a session
	 * that just came back (Resume, app/daemon restart) and is sitting idle;
	 * on one that's been open all along it's a stray prompt. The PTY's
	 * createdAt is the restart - Resume respawns it. Re-evaluated on the 5s poll.
	 */
	const isSettledAgent = (paneId: string) => {
		if (!agentPaneIds.has(paneId)) return false;
		const createdAt = daemonSessions?.sessions.find(
			(session) => session.sessionId === paneId,
		)?.createdAt;
		return (
			!!createdAt && Date.now() - Date.parse(createdAt) > RECENT_RESTART_MS
		);
	};
	// Close local sessions that have sat idle past Settings → Sessions' idle timeout: an open Claude holds
	// memory and a checkout for a conversation Resume can reopen any time. The
	// card stays in its column (odinClosedIn) - closing it answered nothing.
	// A session whose shell is still running something (a dev server) is in use.
	const firstSeenRef = useRef(new Map<string, number>());
	// Re-assigned every render so the one-minute timer below reads current
	// state - an effect keyed on `panes` restarts on every status write and
	// would never get to fire.
	const sweepIdleRef = useRef<() => Promise<void>>(async () => {});
	sweepIdleRef.current = async () => {
		const closeAfterMs = useIdleClose.getState().hours * 60 * 60_000;
		if (closeAfterMs <= 0) return;
		const now = Date.now();
		const stale = Object.values(panes).filter((pane) => {
			if (!pane.odinTaskTitle && !titleByPane[pane.id]) return false;
			// Local only: a remote session holds nothing on this computer, and
			// closing its pane only drops the connection to Claude on the host.
			if (pane.odinRemote) return false;
			if (!agentPaneIds.has(pane.id) || loopingPaneIds.has(pane.id))
				return false;
			if (pane.status === "working" || pane.odinQueued) return false;
			// Waiting on CI: closing it now would file the card under Working
			// for good.
			if (ciChecksByPane.has(pane.id)) return false;
			if (!firstSeenRef.current.has(pane.id))
				firstSeenRef.current.set(pane.id, now);
			// Idle since the later of its last status and its PTY's start: a
			// Resume respawns the PTY without a status, so a session last active
			// hours ago was closed within a minute of being resumed.
			const createdAt = daemonSessions?.sessions.find(
				(session) => session.sessionId === pane.id,
			)?.createdAt;
			const since = Math.max(
				pane.odinStatusAt ?? firstSeenRef.current.get(pane.id) ?? now,
				createdAt ? Date.parse(createdAt) : 0,
			);
			return now - since > closeAfterMs;
		});
		if (stale.length === 0) return;
		const snapshot = await utils.client.resourceMetrics.getSnapshot
			.query()
			.catch(() => undefined);
		if (!snapshot) return;
		const busyShells = new Set(
			snapshot.workspaces
				.flatMap((workspace) => workspace.sessions)
				.filter((session) => session.busy !== false)
				.map((session) => session.paneId),
		);
		for (const pane of stale) {
			const shells = [
				pane.odinShellPaneId,
				...Object.values(pane.odinNamedShells ?? {}),
			];
			if (
				shells.some(
					(shell) => shell && alivePaneIds.has(shell) && busyShells.has(shell),
				)
			)
				continue;
			const column = withMergeReady(
				boardColumn(pane.status ?? "idle", true, pane.odinParked ?? false),
				pane.id,
			);
			useTabsStore.setState((state) => ({
				panes: {
					...state.panes,
					[pane.id]: { ...state.panes[pane.id], odinClosedIn: column },
				},
			}));
			console.warn(`[board] closing idle session ${pane.id} (${column})`);
			await utils.client.terminal.kill
				.mutate({ paneId: pane.id })
				.catch(() => {});
		}
	};
	useEffect(() => {
		const id = setInterval(() => void sweepIdleRef.current(), 60_000);
		return () => clearInterval(id);
	}, []);
	/** Alive PTY currently mid-turn - the one state Resume must not touch. */
	const isWorkingNow = (paneId: string) =>
		agentPaneIds.has(paneId) && panes[paneId]?.status === "working";
	// Drop the "resuming…" flag once the poll actually sees the new PTY - that's
	// the moment the card moves to Working on its own.
	useEffect(() => {
		setResumingPaneIds((ids) => {
			const next = ids.filter((id) => !alivePaneIds.has(id));
			return next.length === ids.length ? ids : next;
		});
	}, [alivePaneIds]);

	// The open drawer can't wait for the scan below: it only reads a screen once
	// the hooks have been quiet for SETTLED_MS, so for two minutes after you
	// Ctrl+C out of Claude the button kept saying Continue. The drawer's xterm
	// already holds the screen - read it directly, with the same two-reads rule.
	// While a session's pane is open, tell Insights you're looking at it. The
	// main process decides whether it counts (focused window, not idle).
	const attend = electronTrpc.insights.attend.useMutation();
	const attendRef = useRef(attend.mutate);
	attendRef.current = attend.mutate;
	const drawerSessionId = drawerCard?.pane.claudeSessionId;
	useEffect(() => {
		if (!drawerSessionId) return;
		const beat = () => {
			if (document.visibilityState === "visible")
				attendRef.current({ sessionId: drawerSessionId });
		};
		const timer = setInterval(beat, 30_000);
		return () => clearInterval(timer);
	}, [drawerSessionId]);

	const drawerPaneId = drawerCard?.pane.id;
	useEffect(() => {
		if (!drawerPaneId || !alivePaneIds.has(drawerPaneId)) return;
		let stopped = false;
		const check = async () => {
			// The chat view mounts no xterm, so ask the daemon for the screen.
			// Without it a parked session whose Claude had quit (the board scan
			// skips parked cards) kept the chat view's "Reply to Claude", and
			// what you sent went to the shell instead of resuming it.
			const screen =
				visibleScreen(drawerPaneId) ||
				((await electronTrpcClient.terminal.readScreen
					.query({ paneId: drawerPaneId })
					.then((result) => result.text)
					.catch(() => null)) ??
					"");
			if (stopped || !screen.trim()) return; // nothing to judge yet
			const gone = !agentOnScreen(screen);
			const goneTwice = gone && sawNoAgentRef.current.has(drawerPaneId);
			if (gone) sawNoAgentRef.current.add(drawerPaneId);
			else sawNoAgentRef.current.delete(drawerPaneId);
			setAgentGonePaneIds((ids) => {
				const next = goneTwice
					? [...new Set([...ids, drawerPaneId])]
					: gone
						? ids
						: ids.filter((id) => id !== drawerPaneId);
				return next.length === ids.length ? ids : next;
			});
		};
		void check();
		const id = setInterval(() => void check(), 1_500);
		return () => {
			stopped = true;
			clearInterval(id);
		};
	}, [drawerPaneId, alivePaneIds]);

	// Compact a conversation the moment its card moves into Idle, while
	// Claude's cache of it is still warm: the next reply, whenever it comes,
	// starts from the summary instead of re-reading the whole conversation
	// cold. The trigger is the arrival effect under cardsByStatus (its rule is
	// onIdleArrival); this is the compaction itself. The screen is read first,
	// twice, for Claude at its prompt with nothing typed, or the command would
	// land under a half-written message. The PreCompact hook moves the card to
	// Working ("Compacting" in the chat view) and the card comes back where it
	// was once the prompt is drawn again.
	const compactingRef = useRef(new Set<string>());
	const compactIdleSession = async (paneId: string) => {
		const readScreen = () =>
			utils.client.terminal.readScreen
				.query({ paneId })
				.catch(() => ({ text: null as string | null }));
		const atFreePrompt = async () => {
			const { text } = await readScreen();
			return (
				!!text && odinScreenStatus(text) === "review" && inputBoxEmpty(text)
			);
		};
		if (!(await atFreePrompt())) return;
		await new Promise((resolve) => setTimeout(resolve, 300));
		if (!(await atFreePrompt())) return;
		const pane = useTabsStore.getState().panes[paneId];
		if (!pane) return;
		const before = {
			status: pane.status,
			odinParked: pane.odinParked,
			odinStatusAt: pane.odinStatusAt,
		};
		// Claimed now, ahead of the PreCompact hook: the next sweep must not
		// type it again, and a compaction Claude declines stays declined until
		// a real turn runs.
		useTabsStore.setState((state) =>
			state.panes[paneId]
				? {
						panes: {
							...state.panes,
							[paneId]: {
								...state.panes[paneId],
								odinCompactedAt: Date.now(),
							},
						},
					}
				: state,
		);
		console.warn(`[board] compacting idle session ${paneId}`);
		await typeIntoClaude(
			utils.client.terminal.write.mutate,
			paneId,
			"/compact",
		);
		// Back where it was once Claude sits at its prompt again - two reads
		// must agree, as the repair scan wants - unless a real turn ran in the
		// meantime (its Start dropped the mark) or a dialog came up.
		const started = Date.now();
		let seenPrompt = 0;
		while (Date.now() - started < COMPACT_WATCH_MS) {
			await new Promise((resolve) => setTimeout(resolve, COMPACT_POLL_MS));
			const current = useTabsStore.getState().panes[paneId];
			if (!current || current.odinCompactedAt === undefined) return;
			const { text } = await readScreen();
			const read = text ? odinScreenStatus(text) : undefined;
			if (read === "permission") return;
			seenPrompt = read === "review" ? seenPrompt + 1 : 0;
			if (seenPrompt < 2) continue;
			const restored = restoreAfterCompact(before, current);
			if (restored)
				useTabsStore.setState((state) =>
					state.panes[paneId]
						? {
								panes: {
									...state.panes,
									[paneId]: { ...state.panes[paneId], ...restored },
								},
							}
						: state,
				);
			return;
		}
	};
	// Screen-reading keeps the columns honest. Agent hooks are the fast path,
	// but they go missing - Stop doesn't fire on Ctrl+C, a notification can miss
	// a pane that wasn't in the store yet, and statuses reset to idle on reload
	// while the PTYs live on. Any of those strands a card mid-flight ("Working"
	// forever on a session that's been sitting at its prompt for an hour), so
	// re-read every live board session on a timer instead of once.
	const setPaneStatusFromStore = useTabsStore((state) => state.setPaneStatus);
	const readingRef = useRef(new Set<string>());
	/** Panes whose last scan read the idle prompt - see the write below. */
	const sawIdlePromptRef = useRef(new Set<string>());
	/** Panes whose last scan found no Claude on screen - same doubt, same fix. */
	const sawNoAgentRef = useRef(new Set<string>());
	const lastScanRef = useRef(0);
	useEffect(() => {
		const scan = () => {
			// `panes` changes on every status write, which re-runs this effect and
			// would otherwise re-read every screen again straight away.
			if (Date.now() - lastScanRef.current < 3_000) return;
			lastScanRef.current = Date.now();
			for (const pane of Object.values(panes)) {
				// You parked it - don't let screen-reading drag it back out of Idle.
				if (pane.odinParked) continue;
				// Nothing to read: a queued task has no process yet.
				if (pane.odinQueued) continue;
				// The hooks and this scan are two writers to one status, and while a
				// turn is running the hooks rewrite it every few seconds. Reading the
				// screen in between only has to be wrong once for the card to flip
				// Working → Needs you → Working. So don't arbitrate: the hooks win
				// while they're live, and this steps in once a status has gone quiet
				// - which is the only case it exists for, because a hook that never
				// arrives leaves the card stuck for hours, not for seconds.
				// Quiet means the *hooks* have stopped talking, not that the status
				// stopped changing. They aren't the same thing: setPaneStatus no-ops
				// on an unchanged value, so a turn's worth of "working" hooks never
				// moves `statusSince` - which left this scan re-reading the screen of
				// every live session every 5 seconds, all turn, and a single bad read
				// bounced the card to Needs you until the next hook bounced it back.
				const since = Math.max(
					statusSinceRef.current.get(pane.id)?.at ?? 0,
					lastAgentHookAt.get(pane.id) ?? 0,
				);
				if (Date.now() - since < SETTLED_MS) continue;
				// Board sessions only - never attach to a terminal the board doesn't own.
				if (!pane.odinTaskTitle && !titleByPane[pane.id]) continue;
				if (!alivePaneIds.has(pane.id)) continue;
				// A read is already in flight for this pane - don't stack them.
				if (readingRef.current.has(pane.id)) continue;
				const tab = tabs.find((item) => item.id === pane.tabId);
				if (!tab) continue;
				readingRef.current.add(pane.id);
				// Reading a screen must not resize the session. createOrAttach hands
				// the host a viewport, and a host old enough to fill in a missing one
				// resizes the live PTY to 80x24 - Claude repaints its TUI at 80
				// columns inside whatever the drawer is actually showing. Send the
				// size the mounted xterm already has, so the resize is a no-op.
				const mounted = terminalCache.get(pane.id)?.xterm;
				(async () => {
					try {
						const result = (await utils.client.terminal.createOrAttach.mutate({
							paneId: pane.id,
							tabId: pane.tabId,
							workspaceId: tab.workspaceId,
							skipColdRestore: true,
							// A read joins an attach already in flight instead of
							// superseding it. Main keeps one pending attach per pane and
							// aborts the older one; when that was the drawer's, its
							// Terminal drops the cancel silently and never starts its
							// stream - a blank drawer until you close and reopen it.
							joinPending: true,
							...(mounted && { cols: mounted.cols, rows: mounted.rows }),
						})) as {
							snapshot?: { snapshotAnsi?: string };
							scrollback?: string;
						};
						const screen = spacesForCursorForward(
							result?.snapshot?.snapshotAnsi ?? result?.scrollback ?? "",
						)
							.replace(ANSI_RE, "")
							.slice(-2500);
						// The PTY outliving the agent is its own state: Ctrl+C out of
						// Claude and the shell is still there, alive to the daemon
						// with no conversation in it. Two reads have to agree -
						// a snapshot caught mid-repaint can come back with none of
						// Claude's chrome on it.
						const gone = !agentOnScreen(screen);
						const goneTwice = gone && sawNoAgentRef.current.has(pane.id);
						if (gone) sawNoAgentRef.current.add(pane.id);
						else sawNoAgentRef.current.delete(pane.id);
						setAgentGonePaneIds((ids) => {
							const next = goneTwice
								? [...new Set([...ids, pane.id])]
								: ids.filter((id) => id !== pane.id);
							return next.length === ids.length ? ids : next;
						});
						// `pane` was captured before the await - read the status the
						// hooks hold now, not the one they held when the scan started.
						const read = odinScreenStatus(screen);
						const current = useTabsStore.getState().panes[pane.id]?.status;
						// The one read worth doubting. A dialog and a spinner are
						// things Claude drew; "sitting at the prompt" is the absence
						// of both, which is also what a snapshot caught mid-repaint
						// looks like - and taking it at face value is what yanked a
						// working card into Needs you until the next hook yanked it
						// back. A tool call outlasting SETTLED_MS still gets here, so
						// make this one wait for a second scan to agree.
						if (read === "review" && current === "working") {
							if (!sawIdlePromptRef.current.has(pane.id)) {
								sawIdlePromptRef.current.add(pane.id);
								return;
							}
						} else {
							sawIdlePromptRef.current.delete(pane.id);
						}
						const status = odinScreenWrite(read, current);
						// An unreadable screen, or one that can't improve on what the
						// hooks already said, leaves the status alone.
						if (status) setPaneStatusFromStore(pane.id, status);
					} catch {
						// leave it be - the next scan or agent event will correct it
					} finally {
						readingRef.current.delete(pane.id);
					}
					// NOTE: do NOT detach here. The whole app shares one socket to the
					// daemon, so detach({paneId}) tears down the stream for the drawer's
					// live terminal too - which was making it render blank.
				})();
			}
		};
		scan();
		const id = setInterval(scan, 5_000);
		return () => clearInterval(id);
	}, [panes, tabs, alivePaneIds, utils, setPaneStatusFromStore, titleByPane]);

	// ── Session tags ───────────────────────────────────────────────────────────
	// Right-click a card to tag it; the pill bar filters the board by tag. Tags
	// live on the pane (app-state.json), so they survive restarts and builds.
	const [tagMenu, setTagMenu] = useState<{
		paneId: string;
		x: number;
		y: number;
	} | null>(null);
	const tagMenuDrop = useDropFor(tagMenu ? panes[tagMenu.paneId] : undefined);
	const watches = useReplyWatch((s) => s.watches);
	const remoteMode = useClaudeCommand((s) => s.remoteControl);
	const remotePanes = useClaudeCommand((s) => s.remotePanes);
	const toggleWatch = useReplyWatch((s) => s.toggle);
	// One filter at a time, from the header dropdown: "tag:<tag>",
	// "repo:<name>", "person:<name>", or "" for everything.
	const [boardFilter, setBoardFilter] = useState("");
	// Free-text search over title, brief, tags, person, repo and PRs. Stacks with
	// the dropdown filter above.
	const [search, setSearch] = useState("");
	const { ref: searchRef, hint: searchHint } = useSearchHotkey();
	// Highlight the Idle column while a card is dragged over it.
	const [dragOverIdle, setDragOverIdle] = useState(false);
	// "Next in line" column - hidden until you ask for it; remembered per machine.
	const [isNextOpen, setIsNextOpen] = useState(() => {
		try {
			return localStorage.getItem("odin:board-next-open") === "1";
		} catch {
			return false;
		}
	});
	const toggleNext = () => {
		const next = !isNextOpen;
		setIsNextOpen(next);
		try {
			localStorage.setItem("odin:board-next-open", next ? "1" : "0");
		} catch {}
	};

	// Tags you typed into the tag menu. Per machine, like the column above -
	// Odin is local-only, so there's no other machine to sync them to.
	const [customTags, setCustomTags] = useState<string[]>(readCustomTags);
	const saveCustomTags = (next: string[]) => {
		setCustomTags(next);
		try {
			localStorage.setItem(CUSTOM_TAGS_KEY, JSON.stringify(next));
		} catch {}
	};

	const setPaneTags = (paneId: string, tags: string[]) => {
		useTabsStore.setState((state) => ({
			panes: {
				...state.panes,
				[paneId]: { ...state.panes[paneId], odinTags: tags },
			},
		}));
	};
	/**
	 * The session's shell pane, if it still exists. Read off the live pane map
	 * rather than the drawer's snapshot - the drawer holds the card it was
	 * opened with, which predates the shell.
	 */
	const shellPaneOf = (card: BoardCard): Pane | undefined => {
		const id = panes[card.pane.id]?.odinShellPaneId;
		return id ? panes[id] : undefined;
	};
	/** The session's named Shells that still exist, by name. */
	const namedShellsOf = (card: BoardCard): [string, Pane][] =>
		Object.entries(panes[card.pane.id]?.odinNamedShells ?? {}).flatMap(
			([name, id]) => (panes[id] ? [[name, panes[id]] as [string, Pane]] : []),
		);
	/**
	 * Open a shell where this session is working. The pane is remembered on the
	 * session, so closing the drawer and coming back reattaches to that shell
	 * (with its history) instead of leaving a new one behind every time.
	 */
	const claudeSessionIdOf = (card: BoardCard) =>
		card.pane.claudeSessionId ??
		usePaneMeta.getState().sessionIdByPane[card.pane.id];
	/** Where the work is - the PR's worktree - not where the session launched. */
	const workDirOf = async (card: BoardCard) => {
		const sessionId = claudeSessionIdOf(card);
		const repo = sessionId
			? await utils.repos.workingRepoName
					.fetch({ claudeSessionId: sessionId }, { staleTime: 60_000 })
					.catch(() => null)
			: null;
		return repo?.worktree ?? repo?.checkout ?? sessionCwd(card.pane);
	};
	const openComposerOnCurrentRepo = () => {
		setComposerRepo("");
		setIsComposerOpen(true);
		const sessionId = drawerCard && claudeSessionIdOf(drawerCard);
		if (!sessionId) return;
		void utils.repos.workingRepoName
			.fetch({ claudeSessionId: sessionId }, { staleTime: 60_000 })
			.then((repo) => setComposerRepo(repo?.owningClone ?? ""))
			.catch(() => {});
	};
	const openShell = async (card: BoardCard) => {
		// Only named Shells so far: show the first rather than opening an empty one.
		const named = namedShellsOf(card);
		if (!shellPaneOf(card) && named.length) {
			setShellName(named[0][0]);
			setIsDiffOpen(false);
			setIsShellOpen(true);
			return;
		}
		setShellName(null);
		if (!shellPaneOf(card)) {
			const { paneId } = useTabsStore.getState().addTab(card.workspaceId, {
				initialCwd: await workDirOf(card),
			});
			// No odinTaskTitle: a shell you opened isn't a task, so it gets no card
			// of its own on the board - same rule the session list uses.
			useTabsStore.setState((state) => ({
				panes: {
					...state.panes,
					[card.pane.id]: {
						...state.panes[card.pane.id],
						odinShellPaneId: paneId,
					},
				},
			}));
		}
		setIsDiffOpen(false);
		setIsShellOpen(true);
	};
	const openFolderInVsCode =
		electronTrpc.external.openFolderInVsCode.useMutation();
	const sendSessionToVsCode =
		electronTrpc.external.sendSessionToVsCode.useMutation();
	const copyText = electronTrpc.external.copyText.useMutation();
	/**
	 * The session moves to VS Code: its folder, and the same conversation in
	 * VS Code's Claude Code panel, or its resume command on the clipboard
	 * without that extension. Never two Claudes on one conversation: a turn
	 * still running stays here, and an idle one is closed here once VS Code has
	 * opened the folder (never before, so a failed open loses nothing), the way
	 * idle sessions are - Resume brings it back.
	 */
	const openInVsCode = async (card: BoardCard, dir?: string) => {
		const folder = dir ?? (await workDirOf(card));
		if (!folder) return toast.error("This session has no folder to open");
		const sessionId = claudeSessionIdOf(card);
		const working = isWorkingNow(card.pane.id);
		const moving = !!sessionId && !working;
		const closeHere = async () => {
			if (!agentPaneIds.has(card.pane.id)) return;
			const column = withMergeReady(
				boardColumn(
					card.pane.status ?? "idle",
					true,
					card.pane.odinParked ?? false,
				),
				card.pane.id,
			);
			useTabsStore.setState((state) => ({
				panes: {
					...state.panes,
					[card.pane.id]: {
						...state.panes[card.pane.id],
						odinClosedIn: column,
					},
				},
			}));
			await utils.client.terminal.kill
				.mutate({ paneId: card.pane.id })
				.catch(() => {});
		};
		const result = await moveToVsCode({
			openFolder: () => openFolderInVsCode.mutateAsync({ path: folder }),
			move:
				moving && sessionId
					? {
							closeHere,
							sendSession: () =>
								sendSessionToVsCode.mutateAsync({ path: folder, sessionId }),
						}
					: undefined,
		});
		if (!result.opened) {
			return toast.error("Couldn't open VS Code", {
				description: `${result.error instanceof Error ? result.error.message : String(result.error)}. The session is still running here.`,
			});
		}
		const { inPanel } = result;
		if (working) {
			return toast.info("Opened the folder in VS Code", {
				description:
					"Claude is still working here, so the conversation stays in Odin. Open it again once the turn ends to move it.",
			});
		}
		if (!sessionId || inPanel) {
			return toast.success("Opened in VS Code", {
				description: sessionId
					? "The conversation continues in VS Code's Claude panel. Resume here brings it back."
					: undefined,
			});
		}
		const cwd = sessionCwd(card.pane);
		await copyText.mutateAsync(
			`${cwd ? `cd '${cwd.replaceAll("'", "'\\''")}' && ` : ""}${claudeLaunch(taskName(card), `--resume ${sessionId}`, card.pane.id)}`,
		);
		toast.success("Opened in VS Code", {
			description:
				"Paste in VS Code's terminal (⌃`) to continue this conversation there.",
			duration: 30_000,
		});
	};
	// Dev only: hold Vite's reloads while a session is open (see coalesceFullReloadPlugin).
	const drawerOpen = !!drawerCard;
	const inCatchUp = !!drawerCard && !!catchUp?.includes(drawerCard.pane.id);
	// Catch up has no Diff or Shell - one left open in a normal drawer doesn't
	// follow you in, since there'd be no button to close it.
	const catchUpLean = inCatchUp && catchUpFull !== drawerCard?.pane.id;
	useEffect(() => {
		import.meta.hot?.send("odin:session-pane", drawerOpen);
		return () => import.meta.hot?.send("odin:session-pane", false);
	}, [drawerOpen]);
	/** The shell the drawer is currently showing, if any. */
	const drawerNamedShells = drawerCard ? namedShellsOf(drawerCard) : [];
	const drawerShell = drawerCard
		? (shellName &&
				drawerNamedShells.find(([name]) => name === shellName)?.[1]) ||
			shellPaneOf(drawerCard) ||
			drawerNamedShells[0]?.[1]
		: undefined;
	/**
	 * This session's shell is already running. A shell that exists but whose PTY
	 * died reads as no shell here - you'd be restarting it, not walking into one
	 * you left mid-command.
	 */
	const shellRunning = !!drawerShell && alivePaneIds.has(drawerShell.id);
	const renamePane = (paneId: string, title: string) => {
		const next = title.trim();
		setRenameDraft(null);
		if (!next) return; // blank = keep the old name
		useTabsStore.setState((state) => ({
			panes: {
				...state.panes,
				[paneId]: {
					...state.panes[paneId],
					odinTaskTitle: next,
					// You named it: auto-rename doesn't get to overrule that.
					odinAutoTitled: true,
				},
			},
		}));
	};
	// Type a tag in the menu: it joins the list and lands on this card.
	const addCustomTag = (paneId: string, raw: string) => {
		const tag = normalizeTag(raw);
		if (!tag) return;
		if (!BOARD_TAGS.includes(tag) && !customTags.includes(tag))
			saveCustomTags([...customTags, tag]);
		const current = boardTags(panes[paneId]?.odinTags, [...customTags, tag]);
		if (!current.includes(tag)) setPaneTags(paneId, [...current, tag]);
	};

	const toggleTag = (paneId: string, tag: string) => {
		// Off-list tags from the older, longer vocabulary are dropped here:
		// touch a card's tags and it comes back clean.
		const current = boardTags(panes[paneId]?.odinTags, customTags);
		setPaneTags(
			paneId,
			current.includes(tag)
				? current.filter((t) => t !== tag)
				: [...current, tag],
		);
	};

	// Search also reaches the repos a session worked in and the PRs it opened
	// ("odin" finds every card with a PR in danlinenberg/odin). Same queries,
	// same options as the card's PR and repo pills, so these are cache hits;
	// transcripts are only fetched while you're searching. Repos always are -
	// the Repos filter needs them.
	const sessionCandidates = Object.values(panes).flatMap((pane) => {
		const sessionId = pane.claudeSessionId ?? sessionIdByPane[pane.id];
		return pane.type === "terminal" && sessionId
			? [{ paneId: pane.id, sessionId }]
			: [];
	});
	const searchCandidates = search.trim() ? sessionCandidates : [];
	const transcriptQueries = electronTrpc.useQueries((t) =>
		searchCandidates.map(({ sessionId }) =>
			t.terminal.readClaudeTranscript(
				{ sessionId },
				{ retry: false, staleTime: 60_000 },
			),
		),
	);
	const repoQueries = electronTrpc.useQueries((t) =>
		sessionCandidates.map(({ sessionId }) =>
			t.repos.workingRepoName(
				{ claudeSessionId: sessionId },
				{ retry: false, staleTime: 60_000 },
			),
		),
	);
	// The repo the agent actually worked in - the launch dir is `~/dev` for
	// every feed session. Same source as the card's RepoPill.
	const workingRepoByPane: Record<string, string> = {};
	sessionCandidates.forEach(({ paneId }, i) => {
		const name = repoQueries[i]?.data?.name;
		if (name) workingRepoByPane[paneId] = name;
	});
	const workingRepoKey = JSON.stringify(workingRepoByPane);
	const workTextByPane: Record<string, string> = {};
	searchCandidates.forEach(({ paneId }, i) => {
		const messages = transcriptQueries[i]?.data?.messages;
		const repo = repoQueries[i]?.data;
		workTextByPane[paneId] = [
			repo?.name,
			repo?.checkout,
			...(messages ? pullRequests(messages) : []).map(
				(pr) => `${pr.url} #${pr.number}`,
			),
		]
			.filter(Boolean)
			.join(" ");
	});
	// A string, so the memo below re-runs when the text changes, not every render.
	const workTextKey = JSON.stringify(workTextByPane);

	const {
		cardsByStatus,
		completedCards,
		allTags,
		allPeople,
		allRepos,
		starredCount,
	} = useMemo(() => {
		const map = new Map<PaneStatus, BoardCard[]>();
		let starred = 0;
		const completed: BoardCard[] = [];
		// Counted over the sessions the board actually shows - counting every
		// pane made the pill promise cards that were killed or aren't tasks.
		const tagCounts = new Map<string, number>();
		const personCounts = new Map<string, number>();
		const repoCounts = new Map<string, number>();
		const workingRepo: Record<string, string> = JSON.parse(workingRepoKey);
		for (const column of COLUMNS) map.set(column.status, []);
		const needle = search.trim().toLowerCase();
		const workText: Record<string, string> = JSON.parse(workTextKey);
		for (const tab of tabs) {
			const workspace = workspaceById.get(tab.workspaceId);
			for (const pane of Object.values(panes)) {
				if (pane.tabId !== tab.id) continue;
				const status = pane.status ?? "idle";
				const card: BoardCard = {
					pane,
					status,
					tabId: tab.id,
					tabName: tab.userTitle ?? tab.name,
					workspaceId: tab.workspaceId,
					repoPath:
						projectById.get(workspace?.projectId ?? "")?.mainRepoPath ?? "",
				};
				if (pane.type !== "terminal") continue; // chat panes aren't board cards
				// Another profile's work - not this board's. Until the profile is
				// known, no card is: on a reload inside another profile, guessing
				// "default" would flash the work board for a frame.
				if (
					isProfileLoading ||
					profileOf(pane.odinProfile) !== activeProfileId
				) {
					continue;
				}
				// Board = agent sessions this app launched. useLaunchTaskSession
				// stamps odinTaskTitle on the pane (older ones only made the
				// localStorage mirror); a terminal you opened yourself has neither
				// and isn't a task.
				if (!pane.odinTaskTitle && !titleByPane[pane.id]) continue;
				// Wait for the first daemon poll so live sessions don't flash dead.
				// "Alive" means the agent, not the PTY: a session you Ctrl+C'd out of
				// leaves a live shell behind, and a shell can't be working on it or
				// waiting on you any more than a dead pane can.
				const alive = agentPaneIds.has(pane.id);
				const dead = daemonSessions !== undefined && !alive;
				// Legacy: panes the removed Kill button marked completed. They stay
				// off the board (Session History is where you resume them) until the
				// persisted state ages out. Nothing sets `completed` any more.
				if (dead && pane.completed) {
					completed.push(card);
					continue;
				}
				const column = withWaiting(
					withMergeReady(
						boardColumn(
							status,
							// `undefined` = the poll hasn't answered yet, which is not "dead".
							daemonSessions === undefined ? undefined : alive,
							pane.odinParked ?? false,
							loopingPaneIds.has(pane.id),
							pane.odinClosedIn,
						),
						pane.id,
					),
					status,
					watchByPane.get(pane.id) ?? "none",
				);
				for (const tag of boardTags(pane.odinTags, customTags))
					tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
				if (pane.odinStarred) starred++;
				const person = pane.odinContact ?? contactByPane[pane.id] ?? null;
				if (person)
					personCounts.set(person, (personCounts.get(person) ?? 0) + 1);
				const repo = workingRepo[pane.id] ?? repoName(card);
				repoCounts.set(repo, (repoCounts.get(repo) ?? 0) + 1);
				if (
					(boardFilter === "starred" && !pane.odinStarred) ||
					(boardFilter.startsWith("person:") &&
						person !== boardFilter.slice(7)) ||
					(boardFilter.startsWith("repo:") && repo !== boardFilter.slice(5)) ||
					(boardFilter.startsWith("tag:") &&
						!boardTags(pane.odinTags, customTags).includes(
							boardFilter.slice(4),
						)) ||
					(needle &&
						![
							pane.odinTaskTitle ?? titleByPane[pane.id],
							pane.userTitle,
							pane.name,
							card.tabName,
							pane.odinBrief ?? briefByPane[pane.id],
							person,
							card.repoPath,
							workText[pane.id],
							...boardTags(pane.odinTags, customTags),
						].some((text) => text?.toLowerCase().includes(needle)))
				)
					continue;
				// Every session stays on the board in its column until it's Done'd -
				// nothing is silently dropped.
				map.get(column)?.push({ ...card, status: column });
			}
		}
		return {
			cardsByStatus: map,
			completedCards: completed,
			starredCount: starred,
			allTags: [...tagCounts.entries()].sort((a, b) =>
				a[0].localeCompare(b[0]),
			),
			allPeople: [...personCounts.entries()].sort((a, b) =>
				a[0].localeCompare(b[0]),
			),
			allRepos: [...repoCounts.entries()].sort((a, b) =>
				a[0].localeCompare(b[0]),
			),
		};
	}, [
		tabs,
		panes,
		workspaceById,
		projectById,
		agentPaneIds,
		loopingPaneIds,
		withMergeReady,
		watchByPane,
		daemonSessions,
		boardFilter,
		search,
		workTextKey,
		workingRepoKey,
		contactByPane,
		titleByPane,
		briefByPane,
		activeProfileId,
		isProfileLoading,
		customTags,
	]);
	// A card is armed for compaction by being seen in any column but Idle, and
	// fires once it turns up in Idle - so a session already parked when the
	// board loads is left alone, and one that comes back to Idle after its own
	// compaction is let go by onIdleArrival (its compaction mark is set). An
	// arrival held for an open drawer stays armed and fires when the drawer
	// closes, which is why drawerPaneId is a dependency.
	const armedForCompactRef = useRef(new Set<string>());
	const compactOnIdle = useIdleCompact((s) => s.enabled);
	const compactIdleSessionRef = useRef(compactIdleSession);
	compactIdleSessionRef.current = compactIdleSession;
	useEffect(() => {
		const armed = armedForCompactRef.current;
		for (const [column, cards] of cardsByStatus) {
			for (const card of cards) {
				const paneId = card.pane.id;
				if (column !== "idle") {
					armed.add(paneId);
					continue;
				}
				if (!armed.has(paneId) || compactingRef.current.has(paneId)) continue;
				const arrival = onIdleArrival(card.pane, {
					enabled: compactOnIdle,
					isAgent: agentPaneIds.has(paneId),
					alive: alivePaneIds.has(paneId),
					looping: loopingPaneIds.has(paneId),
					open: paneId === drawerPaneId,
				});
				if (arrival === "hold") continue;
				armed.delete(paneId);
				if (arrival !== "compact") continue;
				compactingRef.current.add(paneId);
				compactIdleSessionRef
					.current(paneId)
					.catch((error) =>
						console.warn(`[board] compacting ${paneId} failed:`, error),
					)
					.finally(() => compactingRef.current.delete(paneId));
			}
		}
	}, [
		cardsByStatus,
		compactOnIdle,
		drawerPaneId,
		agentPaneIds,
		alivePaneIds,
		loopingPaneIds,
	]);
	// The drawer's session list: what's in flight. Idle is out - those are put
	// down, not in progress. Starred first, then the picked sort; a turn ending
	// or a question stamps odinStatusAt.
	const [switchSort, setSwitchSort] = useState<SwitchSort>(() => {
		try {
			const saved = localStorage.getItem("odin:drawer-sessions-sort");
			return saved && saved in SWITCH_SORTS ? (saved as SwitchSort) : "updated";
		} catch {
			return "updated";
		}
	});
	const pickSwitchSort = (sort: SwitchSort) => {
		setSwitchSort(sort);
		try {
			localStorage.setItem("odin:drawer-sessions-sort", sort);
		} catch {}
	};
	// Grouped by status, Needs you comes first, then Final Review, then Working.
	const [isSwitchGrouped, setIsSwitchGrouped] = useState(() => {
		try {
			return localStorage.getItem("odin:drawer-sessions-group") !== "0";
		} catch {
			return true;
		}
	});
	const toggleSwitchGrouped = () => {
		const next = !isSwitchGrouped;
		setIsSwitchGrouped(next);
		try {
			localStorage.setItem("odin:drawer-sessions-group", next ? "1" : "0");
		} catch {}
	};
	// The time sorts read when a session entered its state, not its newest
	// hook: hooks fire on every tool call, and sorting on them had the Working
	// rows trade places every few seconds. A row moves when its state changes.
	const switchCards = (["permission", "review", "working"] as const)
		.flatMap((status) => cardsByStatus.get(status) ?? [])
		.toSorted(sessionOrder(switchSort, isSwitchGrouped, cardTitle));
	// Idle sits under the list, folded until opened; remembered per machine.
	// Not in switchCards: the next/prev keys reach it only while it's open.
	const idleSwitchCards = (cardsByStatus.get("idle") ?? []).toSorted(
		(a, b) => statusAt(b) - statusAt(a),
	);
	const [isIdleSwitchOpen, setIsIdleSwitchOpen] = useState(() => {
		try {
			return localStorage.getItem("odin:drawer-sessions-idle") === "1";
		} catch {
			return false;
		}
	});
	const toggleIdleSwitch = () => {
		const next = !isIdleSwitchOpen;
		setIsIdleSwitchOpen(next);
		try {
			localStorage.setItem("odin:drawer-sessions-idle", next ? "1" : "0");
		} catch {}
	};
	// The rows as shown, top to bottom: ⌘⌥↑/↓ walk them, and a shift-click
	// ticks a run of them.
	const switchRows = isIdleSwitchOpen
		? [...switchCards, ...idleSwitchCards]
		: switchCards;
	const switchRowIds = switchRows.map((card) => card.pane.id);
	const pickedRowIds = visibleSelection(pickedIds, switchRowIds);
	pickedCountRef.current = pickedRowIds.length;
	const pickedCards = switchRows.filter((card) => pickedIds.has(card.pane.id));
	const tickRow = (paneId: string, shift: boolean) => {
		setPickedIds(
			nextSelection(pickedIds, switchRowIds, paneId, shift, pickAnchor),
		);
		setPickAnchor(paneId);
	};
	const clearPicked = () => {
		setPickedIds(new Set());
		setSelecting(false);
	};
	// ⌘-click ticks a row outside select mode too, so a tick shows the boxes.
	const showTicks = selecting || pickedRowIds.length > 0;
	// Minimized to a rail of status dots; remembered per machine.
	const [isSwitchListMin, setIsSwitchListMin] = useState(() => {
		try {
			return localStorage.getItem("odin:drawer-sessions-min") === "1";
		} catch {
			return false;
		}
	});
	const toggleSwitchList = () => {
		const next = !isSwitchListMin;
		setIsSwitchListMin(next);
		try {
			localStorage.setItem("odin:drawer-sessions-min", next ? "1" : "0");
		} catch {}
	};
	// Two cards on this board working the same ask: each names the other.
	const duplicateOf = useMemo(() => {
		const cards = [...cardsByStatus.values()].flat();
		const byId = new Map(cards.map((card) => [card.pane.id, card]));
		const pairs = duplicateSessions(cards.map((card) => card.pane));
		return new Map(
			[...pairs].flatMap(([id, other]) => {
				const card = byId.get(other);
				return card ? [[id, card] as const] : [];
			}),
		);
	}, [cardsByStatus]);
	// Catch up's call per card, from what the board already read: the sweep,
	// PR states, duplicates and the transcript's ACTION ITEMS.
	const swept = useReview((review) => review.swept);
	const catchUpSuggestionOf = (card: BoardCard): CatchUpSuggestion => {
		const id = card.pane.id;
		const at = mergeCandidates.findIndex((c) => c.paneId === id);
		const other = duplicateOf.get(id);
		return catchUpSuggestion({
			sweptDrop: dropRowFor(swept, card.pane)?.evidence,
			prMerged: reviewMergedPaneIds.has(id),
			prsClosed: droppedPaneIds.has(id),
			duplicateOf: other && cardTitle(other),
			messages: at < 0 ? undefined : mergeTranscripts[at]?.data?.messages,
			urgency: urgencyByPane.get(id),
		});
	};

	// Write the session briefs in the background, so opening a card shows one
	// straight away rather than starting a 15s model call while you wait. The
	// main process queues them one at a time and skips anything still cached, so
	// re-firing this is cheap.
	const warmBriefs =
		electronTrpc.terminal.warmClaudeSessionBriefs.useMutation();
	// Each brief's STATUS line by session id - the drawer's session list shows
	// it under the title. Comes back with every warm, so no call of its own.
	const [briefStatus, setBriefStatus] = useState<Record<string, string>>({});
	const switchStatus = (card: BoardCard) => {
		const id =
			card.pane.claudeSessionId ??
			usePaneMeta.getState().sessionIdByPane[card.pane.id];
		return id ? briefStatus[id] : undefined;
	};
	const { data: autoRename } =
		electronTrpc.settings.getOdinAutoRenameSessions.useQuery();
	// Each id carries whether its card stopped working, so a session finishing
	// re-fires the warm at once and its final brief is ready before you open
	// Catch up - not on the next tick, and not throttled as if still busy.
	const briefSessionIds = useMemo(
		() =>
			[...cardsByStatus]
				.flatMap(([status, cards]) =>
					cards.map((card) => {
						const id =
							card.pane.claudeSessionId ??
							usePaneMeta.getState().sessionIdByPane[card.pane.id];
						return id && (status === "working" ? id : `${id}:settled`);
					}),
				)
				.filter((id): id is string => !!id)
				.sort()
				.join(","),
		[cardsByStatus],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: warmBriefs is a new object each render - the id list is the real trigger
	useEffect(() => {
		if (!briefSessionIds) return;
		const entries = briefSessionIds.split(",");
		const sessionIds = entries.map((entry) => entry.split(":")[0]);
		const settled = entries
			.filter((entry) => entry.endsWith(":settled"))
			.map((entry) => entry.split(":")[0]);
		const warm = () =>
			warmBriefs.mutate(
				{ sessionIds, settled },
				{
					onSuccess: (r) => {
						applyAutoTags(r.tags);
						// Missing until main restarts onto the procedure that returns it.
						setBriefStatus(r.statuses ?? {});
						setBriefUrgency(r.urgencies ?? {});
						if (autoRename) applyAutoTitles(r.titles);
					},
				},
			);
		warm();
		// Live sessions keep working; re-warm so a brief you open later is recent.
		// Every minute, not five: a new card's title only comes back on the call
		// after its brief is written, and a cache hit costs main one stat.
		const timer = setInterval(warm, 60_000);
		return () => clearInterval(timer);
	}, [briefSessionIds, autoRename]);

	/** The crow's conversation is no card, but it still opens in the drawer. */
	const crowCard = (paneId: string): BoardCard | undefined => {
		const pane = panes[paneId];
		const tab = tabs.find((t) => t.id === pane?.tabId);
		if (!pane?.odinTags?.includes(CROW_TAG) || !tab) return undefined;
		const projectId = workspaceById.get(tab.workspaceId)?.projectId ?? "";
		return {
			pane,
			status: pane.status ?? "idle",
			tabId: tab.id,
			tabName: tab.userTitle ?? tab.name,
			workspaceId: tab.workspaceId,
			repoPath: projectById.get(projectId)?.mainRepoPath ?? "",
		};
	};

	// A session just launched from the Tasks view → open its drawer here.
	const pendingPaneId = usePendingFocus((s) => s.paneId);
	const clearPendingFocus = usePendingFocus((s) => s.clear);
	// biome-ignore lint/correctness/useExhaustiveDependencies: openDrawer and crowCard are new each render; the pending pane and the cards are the trigger
	useEffect(() => {
		if (!pendingPaneId) return;
		const card =
			[...cardsByStatus.values()]
				.flat()
				.concat(completedCards)
				.find((c) => c.pane.id === pendingPaneId) ?? crowCard(pendingPaneId);
		if (card) {
			openDrawer(card);
			clearPendingFocus();
		} else if (panes[pendingPaneId] && (boardFilter || search)) {
			// The board's filter or search hides it: asked for by name, so lift
			// them and let this run again on the unfiltered cards.
			setBoardFilter("");
			setSearch("");
		}
	}, [
		pendingPaneId,
		cardsByStatus,
		completedCards,
		clearPendingFocus,
		boardFilter,
		search,
	]);

	/**
	 * Open a session's drawer. For a LIVE pane, purge the pane's cached xterm
	 * and cold-restore marker FIRST (before the Terminal mounts): a session
	 * that was killed+resumed or cold-restored leaves stale module state
	 * (read-only "restored" mode / exited-session gate) that makes the fresh
	 * mount silently drop every keystroke. A clean mount does a clean live
	 * attach - typeable.
	 *
	 * Never purge the pane the drawer is already showing: its Terminal stays
	 * mounted (same paneId, nothing re-runs), so disposing its xterm pulls the
	 * canvas out from under it and the drawer goes blank until reopened.
	 */
	const openDrawer = (card: BoardCard) => {
		if (
			card.pane.type === "terminal" &&
			alivePaneIds.has(card.pane.id) &&
			drawerCard?.pane.id !== card.pane.id
		) {
			coldRestoreState.delete(card.pane.id);
			terminalCache.dispose(card.pane.id);
		}
		// Keep drawerFraction: reopening after Minimize lands where you left it.
		setRenameDraft(null); // don't reopen into a half-typed rename
		setIsShellOpen(false); // the shell belongs to the session you came from
		setDrawerCard(card);
	};

	// A reload (⌘R, a renderer full reload) lands you back in the session you
	// had open, not on the board. sessionStorage: this window only, and gone
	// with it - nothing to bound or clean up.
	const restoredDrawerRef = useRef(false);
	useEffect(() => {
		if (!restoredDrawerRef.current) return;
		try {
			if (drawerCard)
				sessionStorage.setItem(OPEN_DRAWER_KEY, drawerCard.pane.id);
			else sessionStorage.removeItem(OPEN_DRAWER_KEY);
		} catch {
			// storage blocked - a reload just lands on the board
		}
	}, [drawerCard]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the board first has cards
	useEffect(() => {
		if (restoredDrawerRef.current) return;
		const cards = [...cardsByStatus.values()].flat();
		if (cards.length === 0) return;
		restoredDrawerRef.current = true;
		let paneId: string | null = null;
		try {
			paneId = sessionStorage.getItem(OPEN_DRAWER_KEY);
		} catch {
			return;
		}
		const card = paneId
			? cards.find((candidate) => candidate.pane.id === paneId)
			: undefined;
		if (card) openDrawer(card);
	}, [cardsByStatus]);

	// Focus the terminal when a live session's drawer opens, so typing /
	// paste (ctrl+v) / menu keys go straight to Claude Code.
	useEffect(() => {
		if (!drawerCard || drawerCard.pane.type !== "terminal") return;
		if (!alivePaneIds.has(drawerCard.pane.id)) return;
		const focus = () => {
			// alivePaneIds churns on a 5s poll, so this re-runs the whole time the
			// drawer is open, not just when it opens - it can only take the
			// keyboard when nothing else has it.
			if (!canClaimKeyboard()) return;
			// Parked terminals are inert, so the first match can be one that
			// silently refuses focus.
			document
				.querySelector<HTMLTextAreaElement>(
					".xterm-helper-textarea:not(#terminal-parking *)",
				)
				?.focus();
		};
		// A Resume respawns the PTY and remounts the xterm, which can land well
		// after 300ms - one shot left Superwhisper pasting into nothing.
		const timers = [300, 1200, 3500].map((ms) => setTimeout(focus, ms));
		return () => {
			for (const timer of timers) clearTimeout(timer);
		};
	}, [drawerCard, alivePaneIds]);

	/**
	 * Type "Continue" (or `text`) at a live agent's prompt. Text and Enter go in separate
	 * writes: claude's TUI reads a chunk ending in a newline as a paste and
	 * inserts it instead of submitting.
	 */
	const sendContinue = async (paneId: string, text = "Continue") => {
		await terminalWrite.mutateAsync({ paneId, data: text });
		await new Promise((resolve) => setTimeout(resolve, 50));
		await terminalWrite.mutateAsync({ paneId, data: "\r" });
	};

	/**
	 * Remote Control for one session (Settings → Sessions → Selected sessions).
	 * A live agent gets `/remote-control [Odin] <task>` typed at its prompt; a
	 * closed one picks it up on its next Resume.
	 */
	const toggleRemote = (card: BoardCard) => {
		const paneId = card.pane.id;
		const wasOn = remoteControlOn(paneId);
		useClaudeCommand.getState().toggleRemotePane(paneId);
		const live = agentPaneIds.has(paneId);
		if (wasOn)
			return toast.info("Remote Control off from its next Resume", {
				description: live
					? "To disconnect now, type /remote-control in the session."
					: undefined,
			});
		if (!live) return toast.success("Remote Control on from its next Resume");
		const name = remoteControlName(taskName(card));
		void sendContinue(paneId, `/remote-control ${name}`);
		toast.success(`Remote Control on - "${name}"`);
	};

	/**
	 * Pick a session back up. On a live PTY that's literally writing "Continue"
	 * into the open prompt - nothing to reopen.
	 *
	 * On a dead one: reopen the conversation (`claude --resume <id>`) in its worktree,
	 * with no opening prompt - the agent comes back idle, not working. Always
	 * respawns the pane running the command as its process - typing into a
	 * cold-restored shell races its startup (p10k/omz) and gets SIGINT'd, so
	 * we kill any existing session first, then createOrAttach with the command
	 * (no shell-typing race, works whether the prior claude is alive or dead).
	 */
	/**
	 * What a Resume has to wait for - the same gate a launch waits on, since a
	 * resumed agent takes a slot on the Mac like a new one. The card itself is
	 * left out: a session that died mid-turn still reads "working" and would
	 * otherwise hold its own checkout. A failed read lets it through. Huginn
	 * never waits: he's how you free the Mac, not a session that loads it.
	 * A session on the remote host waits on the host's gate instead.
	 */
	const resumeBlocker = async (pane: Pane, cwd: string | undefined) => {
		if (pane.odinTags?.includes(CROW_TAG)) return null;
		if (pane.odinRemote) return currentHostBlocker(utils.client);
		try {
			return (
				(await currentLaunchBlocker(
					utils.client,
					pane.odinCwd ??
						claimedCheckout(undefined, cwd ?? "", workConfig?.odinRepoPath),
					workConfig?.odinRepoPath,
					pane.id,
				)) ?? macPaceBlocker()
			);
		} catch {
			return null;
		}
	};

	/**
	 * Park a Resume in Queued; useTaskQueue runs `command` when the gate clears.
	 * The drawer stays put: it shows the wait and its ▶ Start now.
	 */
	const queueResume = (
		pane: Pane,
		command: string,
		reason: string,
		remote?: NonNullable<Pane["odinQueued"]>["remote"],
	) => {
		useTabsStore.setState((state) => ({
			panes: {
				...state.panes,
				[pane.id]: {
					...state.panes[pane.id],
					status: "idle",
					odinParked: false,
					interrupted: false,
					completed: false,
					odinQueued: { command, reason, ...(remote ? { remote } : {}) },
				},
			},
		}));
	};

	/** Ctrl+C the turn. Shared by the drawer's Interrupt and the chat's stop. */
	const interruptPane = async (paneId: string) => {
		const sent = await interruptClaude(
			utils.client.terminal.write.mutate,
			utils.client.terminal.readScreen.query,
			paneId,
		);
		// Claude fires no Stop hook on an interrupt, so the card would read
		// Working until the scan - and a second click would land Ctrl+C at the
		// idle prompt and start quitting it. Same as Park. Not sent: Claude was
		// already at its prompt, so the turn had ended.
		useTabsStore.setState((state) => ({
			panes: {
				...state.panes,
				[paneId]: { ...state.panes[paneId], status: sent ? "idle" : "review" },
			},
		}));
	};

	/**
	 * `prompt` replaces the opening "Continue" (or the idle prompt): a "Do it"
	 * on an ended session reopens it already working on that item. `restart`
	 * respawns a live session too, so Claude picks up a new login or API key.
	 */
	const resumeCard = async (
		card: BoardCard,
		auto = false,
		prompt?: string,
		restart = false,
	) => {
		if (resumingPaneIds.includes(card.pane.id)) return;
		// A bulk Resume leaves a queued card in line: starting it now is the
		// "Start now" that skips the gate.
		if (auto && card.pane.odinQueued) return;
		// Never started: there's no conversation to resume, only the launch that
		// was held back. Run it now - that's what "Start now" meant on the toast
		// this queue replaced.
		if (card.pane.odinQueued) {
			setResumingPaneIds((ids) => [...ids, card.pane.id]);
			try {
				// Held for the host's room: starting it there anyway is what takes
				// every host session down, so the way past the wait is this Mac.
				if (card.pane.odinQueued.remote) {
					if (!(await moveQueuedToMac(utils.client, card.pane)))
						throw new Error("This one can only start on the remote host");
				} else await startQueuedPane(utils.client, card.pane);
				if (!auto) openDrawer(card);
				void utils.terminal.listDaemonSessions.invalidate();
			} catch (error) {
				toast.error(error instanceof Error ? error.message : String(error));
			} finally {
				setResumingPaneIds((ids) => ids.filter((id) => id !== card.pane.id));
			}
			return;
		}
		// Resume kills the PTY first, so on a session that's mid-turn it's an
		// interrupt wearing a Resume label - it throws away the running turn.
		// Live pane + live status (not the drawer's stale snapshot card).
		if (!restart && isWorkingNow(card.pane.id)) {
			toast.error("Session is still working - nothing to resume");
			return;
		}
		// Live PTY: the button says Continue, so it just says Continue - the
		// conversation is already open, killing it to reopen it would only cost
		// the scrollback. Unless the terminal on screen right now is a bare shell:
		// you just Ctrl+C'd out of Claude, the scan hasn't caught up, and
		// "Continue" typed at zsh is a command-not-found, not a resume.
		const screen = visibleScreen(card.pane.id);
		const shellOnScreen = screen.trim() !== "" && !agentOnScreen(screen);
		const opening = prompt
			? `'${prompt.replaceAll("'", "'\\''")}'`
			: "Continue";
		if (!restart && agentPaneIds.has(card.pane.id) && !shellOnScreen) {
			if (!auto) openDrawer(card);
			// On the host its Claude is already running: Continue costs the host
			// nothing new, and a queued local `claude --resume` would run here.
			const blocker = card.pane.odinRemote
				? null
				: await resumeBlocker(card.pane, sessionCwd(card.pane));
			if (blocker) {
				const id =
					card.pane.claudeSessionId ??
					usePaneMeta.getState().sessionIdByPane[card.pane.id];
				const cwd = sessionCwd(card.pane) ?? card.repoPath;
				if (!id || !cwd) {
					toast.error(`Not now: ${blocker}`);
					return;
				}
				queueResume(
					card.pane,
					`cd '${cwd}' && ${claudeLaunch(
						taskName(card),
						`--resume ${id} ${opening}`,
						card.pane.id,
					)}`,
					blocker,
				);
				return;
			}
			try {
				await sendContinue(card.pane.id, prompt);
			} catch (error) {
				toast.error(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		// What it was doing when it died. A session killed mid-turn (app quit,
		// daemon restart, machine asleep) keeps "working" on its pane - nothing
		// clears it, which is what makes it readable now. Reopening that one at
		// an idle prompt asks you to retype the obvious; reopening a session
		// that had already stopped doesn't.
		const diedWorking =
			useTabsStore.getState().panes[card.pane.id]?.status === "working";
		// initialCwd included: a session whose terminal was never opened has no
		// confirmed cwd, and resuming without one lands in the wrong repo. The
		// workspace checkout is the last resort - `claude --resume` only finds a
		// conversation from the directory it ran in, so resuming from the
		// daemon's default cwd fails exactly like resuming a missing id.
		const cwd = sessionCwd(card.pane) ?? card.repoPath;
		// Resume THIS conversation, not "whatever ran last here" (what --continue
		// does - wrong as soon as two sessions share a workspace). Session id
		// comes from launch (--session-id); for older sessions, look it up in
		// Claude's transcripts by the task title.
		let sessionId =
			card.pane.claudeSessionId ??
			usePaneMeta.getState().sessionIdByPane[card.pane.id];
		// A pinned --session-id is not proof Claude ever wrote that conversation:
		// this pane ran a full turn (its hooks fired) and left no transcript, so
		// Resume ran `claude --resume <id>`, got "No conversation found with
		// session ID" and exited 1 - a dead pane whose whole history was that
		// line. Ask before touching the PTY, and when it's gone stop here: the
		// answer is a new session, which is the drawer's question to ask, not
		// something to do behind your back. Nothing is substituted either - the
		// title search below matches the newest transcript merely *mentioning*
		// the card title (on this board, an unrelated session), and --continue
		// takes whatever ran last in the repo.
		//
		// Read rather than stat: this call already answers "is this conversation
		// on disk" by id alone, and reusing it keeps the whole check in the
		// renderer. A new main-process procedure sits dormant until the app
		// restarts, which is a fix that silently isn't running.
		// Spinner from the click on: the transcript check below can take a beat.
		setResumingPaneIds((ids) => [...ids, card.pane.id]);
		if (sessionId) {
			try {
				await utils.client.terminal.readClaudeTranscript.query({ sessionId });
			} catch (error) {
				// Only "Claude has no such conversation" is lost. An unreadable or
				// half-written transcript still belongs to this card - resume it.
				if (String(error).includes("No transcript on this machine")) {
					setResumingPaneIds((ids) => ids.filter((id) => id !== card.pane.id));
					// Nobody asked - don't pop a dialog at them; the card keeps
					// its Resume button for when they do.
					if (!auto) setLostCard(card);
					return;
				}
			}
		}
		// The respawn puts Claude back in this PTY - don't make the next scan
		// (up to 10s away, twice over) re-prove it before the card stops
		// offering Resume.
		sawNoAgentRef.current.delete(card.pane.id);
		setAgentGonePaneIds((ids) => ids.filter((id) => id !== card.pane.id));
		if (!sessionId && cwd) {
			try {
				const found = await utils.client.terminal.findClaudeSession.query({
					cwd,
					marker: cardTitle(card),
				});
				if (found.sessionId) {
					sessionId = found.sessionId;
					usePaneMeta.getState().setSessionId(card.pane.id, sessionId);
					// Pin it to the pane too, so this lookup happens only once.
					useTabsStore.setState((state) => ({
						panes: {
							...state.panes,
							[card.pane.id]: {
								...state.panes[card.pane.id],
								claudeSessionId: sessionId,
							},
						},
					}));
				}
			} catch {
				// fall back to --continue below
			}
		}
		// The pruner removes a worktree an hour after its PR lands. Without it,
		// `cd` fails and the resume exits at once: a reply that never gets one.
		if (cwd)
			await utils.client.repos.reviveSessionWorktree.mutate({ path: cwd });
		// No opening prompt: Resume reopens the conversation at an idle prompt,
		// it doesn't put the agent back to work. Deciding what happens next is
		// the whole reason you came back to the session. Except mid-turn: that
		// agent comes back with the job half done, so "Continue" rides on the
		// command line. Typing it in once the TUI looked up raced Claude's boot
		// - the write was swallowed and the card needed another Resume click.
		const resumeCmd = claudeLaunch(
			taskName(card),
			`${sessionId ? `--resume ${sessionId}` : "--continue"}${diedWorking || prompt ? ` ${opening}` : ""}`,
			card.pane.id,
		);
		// You resumed it to work in it - bring it up. The drawer swaps its
		// read-only history for the live terminal once the PTY is back, and that
		// terminal takes the keyboard. Auto-resume never steals the screen.
		if (!auto) openDrawer(card);
		// Only a Resume that goes back to work waits on the gate. One reopening
		// at an idle prompt takes no working slot and holds no checkout - queuing
		// it parked you behind every task in line, looking at the board. A bulk
		// Resume always waits: a dozen Claudes spawning at once stall the Mac.
		// So does one on the host, where even an idle Claude takes memory.
		const blocker =
			diedWorking || prompt || auto || card.pane.odinRemote
				? await resumeBlocker(card.pane, cwd)
				: null;
		if (blocker) {
			queueResume(
				card.pane,
				cwd ? `cd '${cwd}' && ${resumeCmd}` : resumeCmd,
				blocker,
				// The queue builds the host command when it starts it.
				card.pane.odinRemote && sessionId
					? {
							pane: sessionId,
							repoPath: cwd ?? null,
							claudeArgs: `--resume ${sessionId}`,
							prompt: prompt ?? null,
						}
					: undefined,
			);
			setResumingPaneIds((ids) => ids.filter((id) => id !== card.pane.id));
			return;
		}
		try {
			// One Claude starting on the host at a time: a ticked batch of remote
			// sessions resumed together froze every one of them there.
			const startIn = card.pane.odinRemote
				? hostStartDelay(card.pane.odinRemote)
				: 0;
			if (startIn > 0) {
				toast.info(
					`Starting on ${card.pane.odinRemote} in ${Math.ceil(startIn / 1000)}s - one session at a time`,
				);
				await new Promise((resolve) => setTimeout(resolve, startIn));
			}
			// Free the pane (dead or a live cold-restored shell) so the respawn
			// re-runs the command. Ignore errors - pane may already be dead.
			await terminalKill.mutateAsync({ paneId: card.pane.id }).catch(() => {});
			// Same purge as openDrawer: a Resume from the open drawer never passes
			// through it, so the respawned PTY mounted the dead one's cached xterm -
			// a blank drawer stuck on Working until closed and reopened. Not while a
			// Terminal shows it: disposing pulls the canvas out from under it.
			if (!terminalCache.get(card.pane.id)?.container) {
				coldRestoreState.delete(card.pane.id);
				terminalCache.dispose(card.pane.id);
			}
			await new Promise((resolve) => setTimeout(resolve, 300));
			// A session on the remote host resumes there: its tmux session if it
			// is still up, else `claude --resume` in its worktree on the host.
			// Restart ends that tmux session first - reattaching would keep the
			// old Claude, with its old login.
			const command =
				card.pane.odinRemote && sessionId
					? await utils.client.remoteHost.sessionCommand.mutate({
							pane: sessionId,
							odinPane: card.pane.id,
							repoPath: cwd ?? null,
							claudeArgs: `--resume ${sessionId}`,
							prompt: prompt ?? null,
							fresh: restart,
						})
					: cwd
						? `cd '${cwd}' && ${resumeCmd}`
						: resumeCmd;
			await utils.client.terminal.createOrAttach.mutate({
				paneId: card.pane.id,
				tabId: card.tabId,
				workspaceId: card.workspaceId,
				cwd,
				command,
				allowKilled: true,
			});
			useTabsStore.setState((state) => ({
				panes: {
					...state.panes,
					[card.pane.id]: {
						...state.panes[card.pane.id],
						// Alive but not working yet. A mid-turn one takes "working"
						// back from its own hooks once its Continue is submitted.
						status: "idle",
						odinParked: false,
						interrupted: false,
						completed: false,
					},
				},
			}));
			// Stay in the drawer: it swaps the read-only history for the live
			// terminal as soon as the daemon poll (invalidated below) sees the PTY.
			// Only the ambiguous --continue fallback is worth interrupting for.
			if (!sessionId) {
				toast.info(
					"Resuming latest session in this repo (no session id found)",
				);
			}
			// Don't sit on the stale poll for up to 5s - ask now so the card leaves
			// Idle as soon as the PTY exists.
			void utils.terminal.listDaemonSessions.invalidate();
			setTimeout(
				() =>
					setResumingPaneIds((ids) => ids.filter((id) => id !== card.pane.id)),
				10_000,
			);
		} catch (error) {
			setResumingPaneIds((ids) => ids.filter((id) => id !== card.pane.id));
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};

	/**
	 * A session whose PTY died mid-turn (app quit, daemon restart, sleep) comes
	 * back on its own - the same Resume the "⏸ died mid-turn" button runs, which
	 * reopens the conversation and types Continue. Only a dead PTY: a live one
	 * with a bare shell is you Ctrl+C'ing out, and that's yours to decide.
	 * A session whose Claude ended with a `/loop` still armed comes back too,
	 * at an idle prompt: the resume books the loop again. So does a session on
	 * the remote host whose pane here died while its Claude kept running in
	 * tmux there: the resume reattaches to it. One question to each host for
	 * its tmux sessions covers every dead card on it; a card whose tmux ended,
	 * or whose host didn't answer, keeps its Resume button. Once per app run
	 * each. One card at a time so each launch-gate check sees the last one's slot.
	 */
	const autoResumedRef = useRef(new Set<string>());
	/**
	 * A session on the remote host, moved here: its branch and uncommitted work
	 * land in a worktree of this computer's checkout, its conversation is
	 * copied from the host, its tmux session there ends, and it resumes told
	 * where it is now. The way out for a session stuck on the host.
	 */
	const runHere = async (card: BoardCard) => {
		const sessionId =
			card.pane.claudeSessionId ??
			usePaneMeta.getState().sessionIdByPane[card.pane.id];
		if (!sessionId) {
			toast.error("This session has no conversation to move.");
			return;
		}
		// The pane's own cwd is the host's once a remote terminal reports it.
		const wanted =
			card.pane.odinCwd || card.pane.initialCwd || card.repoPath || "";
		const loading = toast.loading("Moving the session to this computer...");
		try {
			const { cwd, note, offline } =
				await utils.client.remoteHost.bringHome.mutate({
					sessionId,
					cwd: wanted,
				});
			const pane = {
				...card.pane,
				odinRemote: undefined,
				cwd: undefined,
				initialCwd: cwd,
			};
			useTabsStore.setState((state) => ({
				panes: { ...state.panes, [card.pane.id]: pane },
			}));
			toast.dismiss(loading);
			if (offline)
				toast.warning(
					"The host did not answer, so the conversation moved without its code. The session may still run on the host.",
				);
			await resumeCard({ ...card, pane }, false, note, true);
		} catch (error) {
			toast.dismiss(loading);
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};

	const resumeCardRef = useRef(resumeCard);
	resumeCardRef.current = resumeCard;
	// Covers the transcript check before resumeCard marks the card resuming.
	const autoResumingRef = useRef(false);
	// Re-runs the pick when a resume ends without touching any other dep
	// (lost transcript, queued behind the gate).
	const [autoResumeTick, setAutoResumeTick] = useState(0);
	// Each host's tmux sessions, asked once the dead remote cards in `asked`
	// had died, so a list never vouches for a card that died after it. Asked
	// again when a new one dies, at most once a minute. Null: no answer.
	const liveTmuxRef = useRef(
		new Map<
			string,
			{ names: string[] | null; at: number; asked: Set<string> }
		>(),
	);
	const askingTmuxRef = useRef(new Set<string>());
	const tmuxWaitRef = useRef(new Set<string>());
	// biome-ignore lint/correctness/useExhaustiveDependencies: autoResumeTick is the re-run trigger
	useEffect(() => {
		/**
		 * A dead remote card whose tmux is still up on the host, asking hosts as
		 * needed. Not one Odin closed itself (idle close, run here): that pane
		 * died on purpose.
		 */
		const pickRemoteReconnect = () => {
			const dead = [...cardsByStatus.values()].flat().flatMap((card) => {
				const host = card.pane.odinRemote;
				const sessionId =
					card.pane.claudeSessionId ??
					usePaneMeta.getState().sessionIdByPane[card.pane.id];
				return host &&
					sessionId &&
					!card.pane.odinQueued &&
					!card.pane.odinClosedIn &&
					!alivePaneIds.has(card.pane.id) &&
					!autoResumedRef.current.has(card.pane.id)
					? [{ card, paneId: card.pane.id, host, sessionId }]
					: [];
			});
			const live: Record<string, string[] | null> = {};
			for (const host of new Set(dead.map((d) => d.host))) {
				const known = liveTmuxRef.current.get(host);
				if (known) live[host] = known.names;
				const unasked = dead.some(
					(d) => d.host === host && !known?.asked.has(d.paneId),
				);
				if (!unasked || askingTmuxRef.current.has(host)) continue;
				const wait = known ? known.at + 60_000 - Date.now() : 0;
				if (wait > 0) {
					// Look again once the minute is up, whatever else changes.
					if (!tmuxWaitRef.current.has(host)) {
						tmuxWaitRef.current.add(host);
						setTimeout(() => {
							tmuxWaitRef.current.delete(host);
							setAutoResumeTick((tick) => tick + 1);
						}, wait);
					}
					continue;
				}
				askingTmuxRef.current.add(host);
				const asked = new Set(
					dead.filter((d) => d.host === host).map((d) => d.paneId),
				);
				void utils.client.remoteHost.liveSessions
					.query({ host })
					.catch(() => null)
					.then((names) => {
						liveTmuxRef.current.set(host, { names, at: Date.now(), asked });
						askingTmuxRef.current.delete(host);
						setAutoResumeTick((tick) => tick + 1);
					});
			}
			return remoteCardsToReconnect(
				dead.filter((d) =>
					liveTmuxRef.current.get(d.host)?.asked.has(d.paneId),
				),
				live,
			)[0]?.card;
		};
		if (
			!daemonSessions ||
			resumingPaneIds.length > 0 ||
			autoResumingRef.current
		)
			return;
		const card =
			(cardsByStatus.get("idle") ?? []).find(
				(c) =>
					c.pane.status === "working" &&
					!c.pane.odinQueued &&
					!alivePaneIds.has(c.pane.id) &&
					!autoResumedRef.current.has(c.pane.id),
			) ??
			[...cardsByStatus.values()]
				.flat()
				.find(
					(c) =>
						deadLoopPaneIds.has(c.pane.id) &&
						!agentPaneIds.has(c.pane.id) &&
						!autoResumedRef.current.has(c.pane.id),
				) ??
			pickRemoteReconnect();
		if (!card) return;
		autoResumedRef.current.add(card.pane.id);
		autoResumingRef.current = true;
		void resumeCardRef.current(card, true).finally(() => {
			autoResumingRef.current = false;
			setAutoResumeTick((tick) => tick + 1);
		});
	}, [
		daemonSessions,
		alivePaneIds,
		agentPaneIds,
		cardsByStatus,
		deadLoopPaneIds,
		resumingPaneIds,
		autoResumeTick,
	]);

	const { add: addTask } = useMyTasks();
	const handleNewSession = async (
		rawPrompt: string,
		images: PromptImage[],
		repoPath: string,
		onHost?: boolean,
	) => {
		const prompt = rawPrompt.trim();
		if (!prompt && images.length === 0) return;
		if (useClaudeCommand.getState().toBacklog) {
			if (images.length > 0)
				return void toast.error(
					"Backlog tasks can't keep images or videos yet. Remove them or start the session now.",
				);
			if (!prompt) return;
			addTask(prompt, undefined, repoPath);
			if (repoPath) useClaudeCommand.getState().addRecentRepo(repoPath);
			setIsComposerOpen(false);
			toast.success("Added to My Tasks");
			return;
		}
		const ensured = await ensureWorkspace();
		if (!ensured.ok) {
			toast.error(ensured.error);
			return;
		}
		// First line names the session; the full prompt (multi-line) rides in the
		// task file as the description.
		const title = sessionTitle(prompt, "New session");
		const result = await launch({
			workspaceId: ensured.workspace.id,
			title,
			description: prompt && prompt !== title ? prompt : null,
			images,
			repoPath,
			onHost,
		});
		setIsComposerOpen(false);
		if (result.ok) {
			if (repoPath) useClaudeCommand.getState().addRecentRepo(repoPath);
			// Started from the drawer's session list: land in the new session.
			if (drawerCard) usePendingFocus.getState().focus(result.paneId);
			usePaneMeta.getState().setBrief(result.paneId, prompt || title);
			usePaneMeta.getState().setTitle(result.paneId, title);
			usePaneMeta.getState().setSessionId(result.paneId, result.sessionId);
			toast.success(
				`Session started in ${(repoPath || projectById.get(ensured.workspace.projectId)?.mainRepoPath || "").split("/").pop() || "your repo"}`,
			);
		} else {
			toast.error(result.error);
		}
	};

	/**
	 * What the replacement session should start from: the ask the dead card was
	 * still holding. The brief is the only part of that conversation Odin keeps
	 * for itself - Claude's transcript is what went missing - so it is exactly
	 * what makes starting over feel like carrying on.
	 */
	const lostCardPrompt = (card: BoardCard): string => {
		return restartPrompt(
			cardTitle(card),
			card.pane.odinBrief ?? briefByPane[card.pane.id] ?? null,
		);
	};

	/**
	 * Start over on a card whose conversation is gone: a new session, in the same
	 * checkout, carrying the card's identity (person, feed item, tags) so the
	 * board shows the same piece of work rather than an anonymous new one.
	 *
	 * The dead card is left alone - its scrollback is the only record of what
	 * happened, and Done'ing it for you would throw that away.
	 */
	const startOverFromLost = async (
		card: BoardCard,
		rawPrompt: string,
		images: PromptImage[],
	) => {
		const prompt = rawPrompt.trim();
		if (!prompt && images.length === 0) return;
		const title = sessionTitle(prompt, cardTitle(card));
		const result = await launch({
			workspaceId: card.workspaceId,
			title,
			description: prompt && prompt !== title ? prompt : null,
			images,
			repoPath: sessionCwd(card.pane) ?? card.repoPath,
			contact: cardContact(card),
			pageId: card.pane.odinPageId ?? null,
			source: card.pane.odinSource,
			tags: card.pane.odinTags,
			brief: prompt,
		});
		setLostCard(null);
		if (!result.ok) {
			toast.error(result.error);
			return;
		}
		usePaneMeta.getState().setBrief(result.paneId, prompt || title);
		usePaneMeta.getState().setTitle(result.paneId, title);
		usePaneMeta.getState().setSessionId(result.paneId, result.sessionId);
		// The new card replaces the lost one: left behind, every start-over
		// added a card and the board filled with copies of one task.
		useTabsStore.getState().removePane(card.pane.id);
		setDrawerCard(null);
		// You asked to carry on: land in the new session, not on the board.
		usePendingFocus.getState().focus(result.paneId);
		// The title is the prompt's whole first line - often a paragraph - and a
		// toast that long covers the cards under it.
		toast.success(
			`Started over on "${title.length > 60 ? `${title.slice(0, 59)}…` : title}"`,
		);
	};

	const terminalWrite = electronTrpc.terminal.write.useMutation();
	const terminalKill = electronTrpc.terminal.kill.useMutation();
	/**
	 * Park a card by dragging it to Idle. Idle is the only drop target: the other
	 * columns describe what the agent is actually doing, and dragging a card
	 * can't make that true. A running turn is interrupted first (Ctrl+C) - a card
	 * sitting in Idle while its agent works would be a lie.
	 *
	 * Returns the undo and leaves the toast to the caller: a single Park says
	 * so itself, and many rows at once say it once for the lot.
	 */
	const parkCardQuietly = async (card: BoardCard) => {
		const before = {
			// An interrupted turn can't be un-interrupted: back as a stopped session.
			status: card.pane.status === "working" ? "idle" : card.pane.status,
			odinParked: card.pane.odinParked,
		};
		const undo = pushUndo(() =>
			useTabsStore.setState((state) =>
				state.panes[card.pane.id]
					? {
							panes: {
								...state.panes,
								[card.pane.id]: { ...state.panes[card.pane.id], ...before },
							},
						}
					: state,
			),
		);
		if (card.pane.status === "working") {
			await interruptClaude(
				terminalWrite.mutateAsync,
				utils.client.terminal.readScreen.query,
				card.pane.id,
			).catch(() => {});
		}
		useTabsStore.setState((state) => ({
			panes: {
				...state.panes,
				[card.pane.id]: {
					...state.panes[card.pane.id],
					status: "idle",
					odinParked: true,
				},
			},
		}));
		return undo;
	};
	const parkCard = async (card: BoardCard) => {
		const undo = await parkCardQuietly(card);
		toast.success("Parked in Idle - session still open", undoAction(undo));
	};

	const toggleStar = (paneId: string) =>
		useTabsStore.setState((state) => ({
			panes: {
				...state.panes,
				[paneId]: {
					...state.panes[paneId],
					odinStarred: !state.panes[paneId]?.odinStarred,
				},
			},
		}));

	/**
	 * Done = end it and off the board. removePane kills the PTY and drops the
	 * pane (and its tab, when it's the only one). There used to be a separate
	 * Kill button; it did the same thing minus the cleanup - the card left the
	 * board either way and the orphaned pane/tab stayed behind forever. Session
	 * History resumes finished sessions from Claude's transcripts on disk, so
	 * keeping the dead pane bought nothing. To stop an agent without ending the
	 * session, drag the card to Idle (Park) instead.
	 */
	const markDone = (card: BoardCard, put: PutAway = toDone) => {
		const undo = put.end(card);
		setDrawerCard(null);
		toast.success(put.message, undoAction(undo));
	};

	// The drawer's Done stays in the drawer: the next session opens and the
	// finished row fades out of the side list before it ends.
	const [leavingPaneId, setLeavingPaneId] = useState<string | null>(null);
	// One row of the drawer's session list. A div with button semantics: a real
	// <button> can't nest the tick box.
	// No hover card here: it opened over the session you're reading.
	const switchRow = (card: BoardCard) => {
		const picked = pickedIds.has(card.pane.id);
		return (
			// biome-ignore lint/a11y/useSemanticElements: a real <button> can't nest the tick box <input>
			<div
				role="button"
				tabIndex={0}
				onClick={(event) => {
					// In select mode, or on ⌘-click (Ctrl on Windows), a click ticks
					// the row instead of opening it; shift-click extends a selection.
					if (
						showTicks ||
						event.metaKey ||
						event.ctrlKey ||
						(event.shiftKey && pickedRowIds.length > 0)
					)
						return tickRow(card.pane.id, event.shiftKey);
					openDrawer(card);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						openDrawer(card);
					}
				}}
				onContextMenu={(event) => {
					// Right-click → done, remind, star or tag.
					event.preventDefault();
					setTagMenu({
						paneId: card.pane.id,
						x: event.clientX,
						y: event.clientY,
					});
				}}
				className={cn(
					"flex cursor-pointer items-center gap-2 py-1.5 text-left text-xs transition-[translate,opacity] duration-[450ms]",
					isSwitchListMin ? "justify-center" : "px-3",
					card.pane.id === leavingPaneId
						? "pointer-events-none -translate-x-6 bg-success/20 text-success-ink opacity-0"
						: card.pane.id === drawerCard?.pane.id
							? "bg-primary/15 font-semibold text-foreground"
							: picked
								? "bg-primary/10 text-foreground"
								: "text-muted-foreground hover:bg-accent hover:text-foreground",
				)}
			>
				{isSwitchListMin ? (
					<span
						className="size-2 shrink-0 rounded-full"
						style={{
							background: PANE_STATUS[card.status].dot,
						}}
					/>
				) : (
					// The status dot's slot doubles as the tick box in select mode.
					<span className="relative flex size-3.5 shrink-0 items-center justify-center">
						{showTicks ? (
							<input
								type="checkbox"
								aria-label={`Select ${cardTitle(card)}`}
								title="Select - shift-click selects a range"
								checked={picked}
								onChange={() => {}}
								onClick={(event) => {
									event.stopPropagation();
									tickRow(card.pane.id, event.shiftKey);
								}}
								className="size-3.5 cursor-pointer accent-primary"
							/>
						) : (
							<span
								className="size-2 rounded-full"
								style={{
									background: PANE_STATUS[card.status].dot,
								}}
							/>
						)}
					</span>
				)}
				{!isSwitchListMin && (
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="flex min-w-0 items-center gap-1.5">
							<span className="truncate">
								<WatchMark paneId={card.pane.id} />
								<RemoteMark paneId={card.pane.id} />
								<HostMark
									paneId={card.pane.id}
									state={hostStateOf(card.pane.id)}
								/>
								{cardTitle(card)}
							</span>
							{card.pane.odinStarred && (
								<LuStar
									title="Starred - right-click to unstar"
									className="ml-auto size-[11px] shrink-0 fill-current text-attention"
								/>
							)}
						</span>
						{switchStatus(card) && (
							<span className="truncate text-[10.5px] font-normal text-faint-foreground">
								{switchStatus(card)}
							</span>
						)}
					</span>
				)}
			</div>
		);
	};
	const markDoneInDrawer = (card: BoardCard, put: PutAway = toDone) => {
		const at = switchCards.findIndex((c) => c.pane.id === card.pane.id);
		const next = switchCards[at + 1] ?? switchCards[at - 1];
		if (!next) return markDone(card, put);
		setLeavingPaneId(card.pane.id);
		openDrawer(next);
		setTimeout(() => {
			const undo = put.end(card);
			setLeavingPaneId(null);
			toast.success(put.message, undoAction(undo));
		}, 450);
	};

	/**
	 * Done, undoable: the PTY dies with the pane, so undo resumes the same
	 * conversation (`claude --resume`) into a fresh pane, like Session History.
	 */
	// Every row, not just All's queue: a started Slack row has left the queue,
	// and missing it here left it un-Done - back as new after a Slack reconnect.
	const allTasks = useSearchableItems();
	const { set: setRowDone } = useDone();
	const endCard = (card: BoardCard) => {
		const sessionId =
			card.pane.claudeSessionId ??
			usePaneMeta.getState().sessionIdByPane[card.pane.id];
		const cwd = sessionCwd(card.pane) ?? card.repoPath;
		const title = cardTitle(card);
		const brief = usePaneMeta.getState().briefByPane[card.pane.id];
		// The feed row this session was started on is finished with it.
		const row = allTasks.find((item) => paneWorksOn(card.pane, item));
		if (row) setRowDone(row, true);
		endSession(card.pane.id);
		if (!sessionId) return;
		return pushUndo(async () => {
			if (row) setRowDone(row, false);
			const result = await launch({
				workspaceId: card.workspaceId,
				title,
				description: null,
				resumeSessionId: sessionId,
				repoPath: cwd,
				brief,
			});
			if (!result.ok) return void toast.error(result.error);
			// Undoing Remind me: it's back now, no need to ping about it later.
			useReminders.getState().clear(REMIND_PREFIX + sessionId);
			toast.success(`Back on the board - ${title.slice(0, 50)}`);
		});
	};

	/**
	 * Move to Docs: off the board like Done - the task it was started on is
	 * finished with it - but kept under Docs, where its title reads the
	 * transcript and Back to board resumes it. Undo brings the card back and
	 * takes it off Docs.
	 */
	const endCardToDocs = (card: BoardCard) => {
		const sessionId = claudeSessionIdOf(card);
		if (!sessionId) {
			toast.error("This session has no conversation yet - nothing to keep");
			return;
		}
		const key = sessionDocKey(sessionId);
		const row = {
			title: cardTitle(card),
			source: "session",
			url: null,
			reading: true,
			cwd: sessionCwd(card.pane) ?? card.repoPath,
		};
		const undo = endCard(card);
		useDoneStore.getState().setDone(key, row);
		// Stacked over endCard's own revert, so one ⌘Z does both.
		return pushUndo(() => {
			useDoneStore.getState().setDone(key, null);
			undo?.();
		});
	};
	/** How a card leaves the board: Done, or Move to Docs. */
	type PutAway = {
		end: (card: BoardCard) => (() => void) | undefined;
		message: string;
	};
	const toDone: PutAway = {
		end: endCard,
		message: "Done - removed from board",
	};
	const toDocs: PutAway = { end: endCardToDocs, message: "Moved to Docs" };

	const undoStack = useRef<(() => void)[]>([]);
	/** Stack `revert` for ⌘Z; returns the one-shot undo for this action's toast. */
	const pushUndo = (revert: () => unknown) => {
		const undo = () => {
			const at = undoStack.current.indexOf(undo);
			if (at === -1) return; // already undone
			undoStack.current.splice(at, 1);
			void revert();
		};
		undoStack.current.push(undo);
		return undo;
	};
	const undoLast = () => {
		const last = undoStack.current.at(-1);
		if (!last) return void toast.info("Nothing to undo");
		last();
	};
	const undoAction = (undo?: () => void) =>
		undo && { action: { label: "Undo", onClick: undo } };
	// Text boxes and terminals (xterm's input is a textarea) keep their own ⌘Z.
	useHotkey("ODIN_BOARD_UNDO", undoLast, {
		enableOnFormTags: false,
		enableOnContentEditable: false,
	});
	// ⌘⌥↑/↓ walk the drawer's session list as shown, Idle rows included once
	// the group is open; stops at either end.
	const stepSession = (step: 1 | -1) => {
		if (!drawerCard || inCatchUp) return;
		const at = switchRows.findIndex(
			(card) => card.pane.id === drawerCard.pane.id,
		);
		const card = switchRows[at + step];
		if (card) openDrawer(card);
	};
	// The top bar (layout.tsx) owns the slot; it mounts before this page.
	const [viewToggleSlot, setViewToggleSlot] = useState<HTMLElement | null>(
		null,
	);
	useEffect(() => {
		setViewToggleSlot(document.getElementById(VIEW_TOGGLE_SLOT_ID));
	}, []);
	// The drawer + session list without hunting for a card: needs-you first.
	const openSessions = () => {
		const [first] = switchCards;
		if (!first) return void toast.info("No sessions in flight");
		openDrawer(first);
	};
	const { text: openSessionsKey } = useHotkey(
		"ODIN_OPEN_SESSIONS",
		() => {
			if (!drawerCard) openSessions();
		},
		{ enableOnFormTags: false, enableOnContentEditable: false },
	);
	const { text: prevSessionKey } = useHotkey("PREV_SESSION", () =>
		stepSession(-1),
	);
	const { text: nextSessionKey } = useHotkey("NEXT_SESSION", () =>
		stepSession(1),
	);

	/** Catch up's next card (✓ Done ends this one first), or all caught up. */
	const catchUpNext = (done: boolean) => {
		const queue = catchUp ?? [];
		const current = drawerCard?.pane.id;
		if (done && drawerCard) endCard(drawerCard);
		const live = new Map(
			[...cardsByStatus.values()].flat().map((card) => [card.pane.id, card]),
		);
		const next = queue
			.slice(current ? queue.indexOf(current) + 1 : 0)
			.map((id) => live.get(id))
			.find((card) => card);
		if (next) return openDrawer(next);
		setCatchUp(null);
		setDrawerCard(null);
		toast.success("All caught up");
	};

	const catchUpCall =
		inCatchUp && drawerCard ? catchUpSuggestionOf(drawerCard) : null;
	/** Do what Catch up suggests: Done, or open the PR, or open the session. */
	const acceptCatchUp = (suggestion: CatchUpSuggestion) => {
		if (suggestion.kind === "yours") return setCatchUp(null);
		if (suggestion.kind === "merge") {
			if (suggestion.url) openUrl(suggestion.url);
			return catchUpNext(false);
		}
		catchUpNext(true);
	};
	// One key per card: Enter takes the suggestion, → skips, E is Done.
	const catchUpKeys = {
		enabled: !!catchUpCall,
		enableOnFormTags: false,
		enableOnContentEditable: false,
	};
	useHotkey(
		"CATCH_UP_ACCEPT",
		() => catchUpCall && acceptCatchUp(catchUpCall),
		catchUpKeys,
	);
	useHotkey("CATCH_UP_SKIP", () => catchUpNext(false), catchUpKeys);
	useHotkey("CATCH_UP_DONE", () => catchUpNext(true), catchUpKeys);

	// Done from wherever the card is: the open session moves the drawer on,
	// another row in the drawer's list leaves the drawer where it is.
	const doneAnywhere = (card: BoardCard, put: PutAway = toDone) => {
		if (card.pane.id === drawerCard?.pane.id)
			return markDoneInDrawer(card, put);
		if (!drawerCard) return markDone(card, put);
		toast.success(put.message, undoAction(put.end(card)));
	};
	// The ticked rows of the drawer's session list, acted on together: one
	// toast for the lot, and one Undo that puts every session back.
	const resumablePicked = resumable(pickedCards, agentPaneIds);
	const parkablePicked = parkable(pickedCards);
	const sessions = (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`;
	const resumePicked = () => {
		// A beat apart, not all at once: each Resume spawns a Claude, and a
		// dozen spawning in the same instant stalls the Mac and the daemon.
		// Each one passes the launch gate too, so past the first few they wait
		// in Queued and the queue starts them as there's room.
		resumablePicked.forEach((card, i) => {
			setTimeout(() => void resumeCard(card, true), i * 300);
		});
		toast.success(`Resuming ${sessions(resumablePicked.length)}`);
		clearPicked();
	};
	const finishPicked = () => {
		const undos = pickedCards
			.map((card) => toDone.end(card))
			.filter((undo): undo is () => void => undo !== undefined);
		// The session on screen was among them: on to the next row, or close.
		if (pickedCards.some((card) => card.pane.id === drawerCard?.pane.id)) {
			const next = switchRows.find((card) => !pickedIds.has(card.pane.id));
			if (next) openDrawer(next);
			else setDrawerCard(null);
		}
		toast.success(
			`Done - ${sessions(pickedCards.length)} removed from board`,
			undoAction(
				undos.length
					? () => {
							for (const undo of undos) undo();
						}
					: undefined,
			),
		);
		clearPicked();
	};
	const parkPicked = async () => {
		const cards = parkablePicked;
		clearPicked();
		const undos = await Promise.all(cards.map(parkCardQuietly));
		toast.success(
			`Parked ${sessions(cards.length)} in Idle - still open`,
			undoAction(() => {
				for (const undo of undos) undo();
			}),
		);
	};
	const liveCard = (paneId: string | undefined) =>
		paneId
			? [...cardsByStatus.values()].flat().find((c) => c.pane.id === paneId)
			: undefined;
	const tagMenuCard = liveCard(tagMenu?.paneId);
	// drawerCard is the card as it was opened; its column is the board's now.

	/** Done now; on `day` it pings and waits above the columns to be resumed. */
	// What "Ping me" watches for the right-clicked session.
	const tagMenuWatchKeys = useSessionWatchKeys(tagMenuCard);

	// Cards are memoized, so they get one stable set of handlers that always
	// call this render's versions.
	const cardActionsRef = useRef<CardActions | null>(null);
	const [cardActions] = useState<CardActions>(() => ({
		openDrawer: (card) => cardActionsRef.current?.openDrawer(card),
		setDragOverIdle: (over) => cardActionsRef.current?.setDragOverIdle(over),
		setTagMenu: (at) => cardActionsRef.current?.setTagMenu(at),
		toggleStar: (paneId) => cardActionsRef.current?.toggleStar(paneId),
		markDone: (card) => cardActionsRef.current?.markDone(card),
		remindMe: (card, day) => cardActionsRef.current?.remindMe(card, day),
		resumeCard: async (card) => cardActionsRef.current?.resumeCard(card),
		cardTitle: (card) => cardActionsRef.current?.cardTitle(card) ?? "",
	}));
	const remindMe = (card: BoardCard, day: string) => {
		const sessionId =
			card.pane.claudeSessionId ??
			usePaneMeta.getState().sessionIdByPane[card.pane.id];
		const cwd = sessionCwd(card.pane) ?? card.repoPath;
		if (!sessionId || !cwd) {
			toast.error(
				"This session has no conversation id - can't resume it later",
			);
			return;
		}
		const title = cardTitle(card);
		remindSession(
			{
				sessionId,
				cwd,
				title,
				brief: usePaneMeta.getState().briefByPane[card.pane.id],
			},
			day,
		);
		doneAnywhere(card);
		toast.success(`Reminding you ${day} - ${title.slice(0, 50)}`);
	};
	cardActionsRef.current = {
		openDrawer,
		setDragOverIdle,
		setTagMenu,
		toggleStar,
		markDone,
		remindMe,
		resumeCard: async (card) => {
			await resumeCard(card);
		},
		cardTitle,
	};

	return (
		<div className="flex h-full flex-col">
			{/* One header row: title, launcher, filter dropdown. */}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-[18px] pb-2 pt-2.5">
				<h1 className="text-[15px] font-semibold">Dev Board</h1>
				<button
					type="button"
					title="Describe a task and start an agent session"
					onClick={openComposerOnCurrentRepo}
					className={cn(
						"rounded-lg px-2.5 py-1 text-[12px] font-semibold transition-colors",
						BUTTON.primary,
					)}
				>
					+ New Session
				</button>
				{isLaunching && (
					<span className="text-xs text-muted-foreground">starting…</span>
				)}

				<input
					ref={searchRef}
					type="search"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					onKeyDown={(e) => {
						if (e.key !== "Escape") return;
						setSearch("");
						e.currentTarget.blur();
					}}
					placeholder={`Search sessions${searchHint}`}
					className={cn(
						"w-[220px] rounded-full border bg-card px-2.5 py-1 text-[12px] text-foreground outline-none placeholder:text-faint-foreground focus:border-primary",
						search ? "border-primary" : "border-border",
					)}
				/>

				{/* filter - right-click a card to tag it; people are the card's contact */}
				{(allTags.length > 0 ||
					allPeople.length > 0 ||
					allRepos.length > 1 ||
					starredCount > 0) && (
					<select
						value={boardFilter}
						onChange={(e) => setBoardFilter(e.target.value)}
						title="Show only starred sessions, or those with this tag, repo or person"
						className={cn(
							"max-w-[220px] cursor-pointer rounded-full border px-2.5 py-1 text-[12px] font-medium outline-none",
							boardFilter
								? "border-primary bg-primary/15 text-foreground"
								: "border-border bg-card text-muted-foreground hover:text-foreground",
						)}
					>
						<option value="">All sessions</option>
						{starredCount > 0 && (
							<option value="starred">★ Starred ({starredCount})</option>
						)}
						{allTags.length > 0 && (
							<optgroup label="Tags">
								{allTags.map(([tag, count]) => (
									<option key={tag} value={`tag:${tag}`}>
										#{tag} ({count})
									</option>
								))}
							</optgroup>
						)}
						{allRepos.length > 1 && (
							<optgroup label="Repos">
								{allRepos.map(([repo, count]) => (
									<option key={repo} value={`repo:${repo}`}>
										{repo} ({count})
									</option>
								))}
							</optgroup>
						)}
						{allPeople.length > 0 && (
							<optgroup label="People">
								{allPeople.map(([person, count]) => (
									<option key={person} value={`person:${person}`}>
										{person} ({count})
									</option>
								))}
							</optgroup>
						)}
					</select>
				)}

				<span className="ml-auto" aria-hidden />
				<NightAgentLive
					onClick={() => {
						if (!isNextOpen) toggleNext();
					}}
				/>
				{/* One toggle in the top bar, in the same spot whether the drawer is
				    open or not - a copy in the toolbar and one in the drawer jumped
				    across the screen on every click. */}
				{viewToggleSlot &&
					!inCatchUp &&
					createPortal(
						<ViewToggle
							sessionsOpen={!!drawerCard}
							sessionsDisabled={switchCards.length === 0}
							sessionsKey={openSessionsKey}
							onSessions={() => {
								if (!drawerCard) openSessions();
							}}
							onBoard={() => setDrawerCard(null)}
						/>,
						viewToggleSlot,
					)}
				{/* A view toggle, not a filter - kept apart from search and the dropdown. */}
				<button
					type="button"
					onClick={toggleNext}
					aria-pressed={isNextOpen}
					title={
						isNextOpen
							? "Hide the Next in line column"
							: "Show the tasks worth starting next"
					}
					className={cn(
						"flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium",
						isNextOpen
							? "border-primary bg-primary/15 text-foreground"
							: "border-border bg-card text-muted-foreground hover:text-foreground",
					)}
				>
					{isNextOpen ? (
						<LuEye className="size-3.5" aria-hidden />
					) : (
						<LuEyeOff className="size-3.5" aria-hidden />
					)}
					Next in line
					<TonightCount />
				</button>
			</div>

			<SessionReminders />
			<WatchKeySyncs cards={[...cardsByStatus.values()].flat()} />

			{tagMenu && (
				<TagMenu
					x={tagMenu.x}
					y={tagMenu.y}
					tags={boardTags(panes[tagMenu.paneId]?.odinTags, customTags)}
					allTags={BOARD_TAGS}
					customTags={customTags}
					onAdd={(tag) => addCustomTag(tagMenu.paneId, tag)}
					onForget={(tag) =>
						saveCustomTags(customTags.filter((t) => t !== tag))
					}
					starred={!!panes[tagMenu.paneId]?.odinStarred}
					onKeep={
						tagMenuDrop
							? () =>
									useBacklogReview
										.getState()
										.keep(activeProfileId, tagMenuDrop.key)
							: undefined
					}
					onStar={() => toggleStar(tagMenu.paneId)}
					onDone={() => tagMenuCard && doneAnywhere(tagMenuCard)}
					onPark={
						tagMenuCard && tagMenuCard.status !== "idle"
							? () => void parkCard(tagMenuCard)
							: undefined
					}
					onDocs={
						tagMenuCard &&
						!tagMenuCard.pane.odinQueued &&
						claudeSessionIdOf(tagMenuCard)
							? () => doneAnywhere(tagMenuCard, toDocs)
							: undefined
					}
					onRestart={
						tagMenuCard && !tagMenuCard.pane.odinQueued
							? () => void resumeCard(tagMenuCard, false, undefined, true)
							: undefined
					}
					onRunHere={
						tagMenuCard?.pane.odinRemote && !tagMenuCard.pane.odinQueued
							? () => void runHere(tagMenuCard)
							: undefined
					}
					onRemind={(day) => tagMenuCard && remindMe(tagMenuCard, day)}
					watching={
						tagMenuWatchKeys.length
							? Object.values(watches).some((w) => w.paneId === tagMenu.paneId)
							: undefined
					}
					watchWhat={[
						...new Set(
							tagMenuWatchKeys.map((k) =>
								k.startsWith("pr:") ? "approval" : "replies",
							),
						),
					].join(" and ")}
					onWatch={() =>
						tagMenuCard &&
						toggleWatch(
							tagMenuWatchKeys,
							cardTitle(tagMenuCard),
							tagMenuCard.pane.id,
						)
					}
					remote={
						remoteMode === "selected"
							? remotePanes.includes(tagMenu.paneId)
							: undefined
					}
					onRemote={() => tagMenuCard && toggleRemote(tagMenuCard)}
					onSaveDoc={
						agentPaneIds.has(tagMenu.paneId)
							? () =>
									void typeIntoClaude(
										terminalWrite.mutateAsync,
										tagMenu.paneId,
										SAVE_DOC_PROMPT,
									).then(() => toast.success("Asked the agent to save a doc"))
							: undefined
					}
					onToggle={(tag) => toggleTag(tagMenu.paneId, tag)}
					onClose={() => setTagMenu(null)}
				/>
			)}

			<div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-[18px] pb-[18px] pt-1">
				{COLUMNS.map((column) => {
					const cards = cardsByStatus.get(column.status) ?? [];
					const sections = bySection(
						cards,
						(card) =>
							(column.status === "review" || column.status === "permission") &&
							justDoneLeft(
								statusSinceRef.current.get(card.pane.id)?.at,
								focusedAt,
							) > 0,
						(card) =>
							column.status === "idle" &&
							watchByPane.get(card.pane.id) === "waiting",
					);
					// One section is just the column - don't label it, unless it says
					// something on its own (Starred, Parked: "you put these down").
					const labelled =
						sections.length > 1 ||
						sections[0]?.[0] === "starred" ||
						sections[0]?.[0] === "recent" ||
						sections[0]?.[0] === "parked" ||
						sections[0]?.[0] === "queued" ||
						sections[0]?.[0] === "waiting";
					const isDropTarget = column.status === "idle";
					// Needs you and Done are the two columns you clear: walk either one
					// card at a time - once there are more than five, fewer you just scan.
					const canCatchUp =
						(column.status === "permission" || column.status === "review") &&
						cards.length > 5;
					return (
						// biome-ignore lint/a11y/noStaticElementInteractions: drop zone - drag is the mouse-only shortcut for parking a card in Idle
						<div
							key={column.status}
							onDragOver={
								isDropTarget
									? (event) => {
											event.preventDefault();
											setDragOverIdle(true);
										}
									: undefined
							}
							onDragLeave={
								isDropTarget ? () => setDragOverIdle(false) : undefined
							}
							onDrop={
								isDropTarget
									? (event) => {
											event.preventDefault();
											setDragOverIdle(false);
											const paneId = event.dataTransfer.getData("text/plain");
											const card = [...cardsByStatus.values()]
												.flat()
												.find((item) => item.pane.id === paneId);
											if (card) void parkCard(card);
										}
									: undefined
							}
							className={cn(
								// The column wears its status: a hairline of the hue along the
								// top and a wash that fades out under the header. The cards
								// stay neutral - the colour says where they are, not what.
								BOARD_COLUMN_MIN_W,
								"relative flex flex-1 flex-col overflow-hidden rounded-xl border bg-tertiary/85 bg-[linear-gradient(to_bottom,color-mix(in_oklab,var(--col)_9%,transparent),transparent_160px)]",
								isDropTarget && dragOverIdle
									? "border-primary bg-primary/15"
									: "border-border",
							)}
							style={
								{ "--col": PANE_STATUS[column.status].dot } as CSSProperties
							}
						>
							<span
								aria-hidden
								className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-(--col) via-(--col)/40 to-transparent"
							/>
							<div className="flex items-center gap-2 px-3 py-2.5 text-xs font-semibold uppercase tracking-[.4px] text-soft-foreground">
								<span className="size-2 rounded-full bg-(--col) shadow-[0_0_8px_var(--col)]" />
								{PANE_STATUS[column.status].label}
								{canCatchUp && (
									<button
										type="button"
										title="Catch up - go through these one at a time"
										onClick={() => {
											const queue = catchUpOrder(
												sections.flatMap(([, group]) => group),
												catchUpSuggestionOf,
											);
											setCatchUp(queue.map((card) => card.pane.id));
											openDrawer(queue[0]);
										}}
										// Solid, with a play icon: the dim pill read as a tag beside
										// the count, not as something to press. Wears the column's hue.
										className={cn(
											"ml-auto flex items-center gap-1 rounded-md bg-gradient-to-b to-(--col) px-2.5 py-1 text-[11px] font-semibold normal-case tracking-normal text-background shadow-[0_2px_10px_-3px_color-mix(in_oklab,var(--col)_75%,transparent)] hover:brightness-110",
											column.status === "review"
												? "from-success-ink"
												: "from-attention-ink",
										)}
									>
										<LuPlay className="size-2.5 fill-current" />
										Catch up
									</button>
								)}
								<span
									className={cn(
										"rounded-[10px] bg-secondary px-2 font-medium",
										!canCatchUp && "ml-auto",
									)}
								>
									{isBoardSettled ? cards.length : "-"}
								</span>
							</div>
							<div className="flex flex-col gap-2 overflow-y-auto px-2 pt-0.5 pb-2.5">
								{!isBoardSettled ? (
									<div className="flex justify-center py-6">
										<output
											aria-label="Loading sessions"
											className="size-[14px] animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
										/>
									</div>
								) : cards.length === 0 ? (
									<div className="px-2 py-6 text-center text-xs text-muted-foreground">
										Nothing here
									</div>
								) : (
									sections.map(([section, group]) => {
										const Icon = SECTION_ICON[section];
										return (
											<Fragment key={section}>
												{labelled && (
													<div className="flex items-center gap-1.5 px-1 pt-1 text-[10px] font-semibold uppercase tracking-[.5px] text-muted-foreground">
														<Icon className="size-3" aria-hidden />
														{SECTION_LABEL[section]}
														<span className="opacity-70">{group.length}</span>
														<span className="ml-1 h-px flex-1 bg-accent" />
													</div>
												)}
												{group.map((card) => (
													<BoardCardTile
														key={card.pane.id}
														card={card}
														actions={cardActions}
														title={cardTitle(card)}
														hoverText={cardText(card)}
														contact={cardContact(card)}
														dropped={droppedPaneIds.has(card.pane.id)}
														merged={reviewMergedPaneIds.has(card.pane.id)}
														ciChecks={ciChecksByPane
															.get(card.pane.id)
															?.join(", ")}
														conflicts={conflictsByPane.get(card.pane.id)}
														duplicate={duplicateOf.get(card.pane.id)}
														since={statusSinceRef.current.get(card.pane.id)?.at}
														focusedAt={focusedAt}
														customTags={customTags}
														launchEmoji={launchEmoji}
														isAgent={agentPaneIds.has(card.pane.id)}
														hostState={hostStateOf(card.pane.id)}
														resuming={resumingPaneIds.includes(card.pane.id)}
														shellPane={shellPaneOf(card)}
														shellAlive={alivePaneIds.has(
															shellPaneOf(card)?.id ?? "",
														)}
														hasDaemon={!!daemonSessions}
													/>
												))}
											</Fragment>
										);
									})
								)}
							</div>
						</div>
					);
				})}
				{/* Last, so it opens under its toggle at the header's right end. */}
				{isNextOpen && <NextInLine />}
			</div>

			{/* No Completed strip and no link to one: the Session History pane in the
			    sidebar already searches and resumes finished sessions. */}

			{/* session drawer */}
			{drawerCard && (
				<>
					<button
						type="button"
						aria-label="Close drawer"
						className={cn(
							"fixed inset-0 z-40 cursor-default bg-none",
							inCatchUp ? "bg-black/70" : "bg-black/35",
						)}
						onClick={() => setDrawerCard(null)}
					/>
					{/* Catch up (Slack mobile's): the drawer becomes the top card of a
					    stack, with how many are left above it and Next / Done below. */}
					{inCatchUp && catchUp && catchUpCall && (
						<>
							<div className="absolute left-1/2 top-3 z-50 flex w-[min(760px,calc(100%-32px))] -translate-x-1/2 items-center justify-center">
								<button
									type="button"
									title="Stop catching up - back to the board"
									onClick={() => {
										setCatchUp(null);
										setDrawerCard(null);
									}}
									className="absolute left-0 px-2 text-2xl leading-none text-muted-foreground hover:text-foreground"
								>
									‹
								</button>
								<span className="text-base font-semibold text-foreground">
									{catchUp.length - catchUp.indexOf(drawerCard.pane.id)} Left
								</span>
							</div>
							<div className="absolute bottom-5 left-1/2 z-50 flex w-[min(760px,calc(100%-32px))] -translate-x-1/2 gap-4">
								<button
									type="button"
									title="Leave it on the board and go to the next one (→)"
									onClick={() => catchUpNext(false)}
									className={cn(
										"flex-1 rounded-2xl py-3.5 text-[15px] font-semibold",
										BUTTON.secondary,
									)}
								>
									Skip
								</button>
								<button
									type="button"
									title={`${catchUpCall.why} (Enter)`}
									onClick={() => acceptCatchUp(catchUpCall)}
									className={cn(
										"flex-[1.6] rounded-2xl py-3.5 text-[15px] font-semibold",
										SUGGESTION[catchUpCall.kind].style,
									)}
								>
									{SUGGESTION[catchUpCall.kind].button}
								</button>
								{catchUpCall.kind !== "done" && (
									<button
										type="button"
										title="Done anyway - remove it from the board and go to the next one (E)"
										onClick={() => catchUpNext(true)}
										className={cn(
											"rounded-2xl px-5 py-3.5 text-[15px] font-semibold",
											BUTTON.done,
										)}
									>
										✓ Done
									</button>
								)}
							</div>
						</>
					)}
					{/* absolute, not fixed: it fills the content area, which starts below
					    the top bar. A top-0 fixed drawer put its title under the macOS
					    traffic lights, and the native buttons eat the click. */}
					<div
						className={cn(
							"@container absolute z-50 flex flex-col bg-tertiary",
							inCatchUp
								? // Two cards peeking out underneath: the rest of the pile.
									"bottom-[92px] left-1/2 top-12 w-[min(760px,calc(100%-32px))] -translate-x-1/2 overflow-hidden rounded-[26px] border border-border shadow-[0_8px_0_-3px_var(--card),0_16px_0_-6px_var(--tertiary)]"
								: "right-0 top-0 h-full max-w-full border-l border-border",
						)}
						style={
							inCatchUp
								? undefined
								: {
										width: `max(${MIN_DRAWER_W}px, calc((100vw - ${RAIL_W}px) * ${drawerFraction}))`,
									}
						}
					>
						{/* drag handle - resize the drawer from its left edge */}
						{!inCatchUp && (
							<div
								onPointerDown={startDrawerResize}
								className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-primary/40"
							/>
						)}
						{/* Minimize, on the edge the pointer is already on - the Close
						    button is a whole drawer away. The session keeps running. */}
						{!inCatchUp && (
							<button
								type="button"
								aria-label="Minimize"
								title="Minimize - back to the board (the session keeps running)"
								onClick={() => setDrawerCard(null)}
								className="absolute left-0 top-1/2 z-20 -translate-y-1/2 rounded-r-[7px] border border-l-0 border-border bg-secondary py-2.5 pl-[3px] pr-1 text-[11px] leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
							>
								›
							</button>
						)}
						<div className="border-b border-border px-4 py-2">
							<div className="flex items-center gap-2">
								{renameDraft === null ? (
									<button
										type="button"
										title="Click to rename this session"
										onClick={() => setRenameDraft(cardTitle(drawerCard))}
										className="min-w-0 truncate text-left text-sm font-semibold hover:text-primary"
									>
										{cardTitle(drawerCard)}
									</button>
								) : (
									<input
										// Focus on mount without the autoFocus attribute the a11y
										// lint flags - same trick as TagMenu's input.
										ref={(element) => element?.focus()}
										value={renameDraft}
										onChange={(event) => setRenameDraft(event.target.value)}
										onBlur={() => renamePane(drawerCard.pane.id, renameDraft)}
										onKeyDown={(event) => {
											if (event.key === "Enter")
												renamePane(drawerCard.pane.id, renameDraft);
										}}
										className="min-w-0 flex-1 rounded-md border border-primary bg-background px-2 py-1 text-sm font-semibold text-foreground outline-none"
									/>
								)}
								<div className="mr-auto flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
									{cardContact(drawerCard) && (
										<PersonChip name={cardContact(drawerCard) as string} />
									)}
									{drawerLink && (
										<button
											type="button"
											title={drawerLink.url}
											onClick={() => openUrl(drawerLink.url)}
											className={cn(
												"rounded-[5px] px-[7px] text-[11px] font-medium hover:underline",
												PILL.brand,
											)}
										>
											{drawerLink.label} ↗
										</button>
									)}
									<WatchPill paneId={drawerCard.pane.id} />
									{remoteMode === "selected" && (
										<button
											type="button"
											title="Follow and answer this session from claude.ai/code or the Claude app. Click to switch."
											onClick={() => toggleRemote(drawerCard)}
											className={cn(
												"flex items-center gap-1 rounded-[5px] px-[7px] text-[11px] font-medium",
												remotePanes.includes(drawerCard.pane.id)
													? PILL.brand
													: "bg-secondary text-muted-foreground hover:text-foreground",
											)}
										>
											<LuRadioTower className="size-3" aria-hidden />
											Remote Control
											{remotePanes.includes(drawerCard.pane.id) ? " on" : ""}
										</button>
									)}
									{sessionCwd(drawerCard.pane) && (
										<span
											title={sessionCwd(drawerCard.pane)}
											className="rounded-[5px] bg-secondary px-[7px] text-[11px] text-muted-foreground"
										>
											{sessionCwd(drawerCard.pane)?.split("/").slice(-1)[0]}
										</span>
									)}
									<span className="rounded-[5px] bg-secondary px-[7px] text-[11px] text-muted-foreground">
										{PANE_STATUS[drawerCard.status].label}
									</span>
									<button
										type="button"
										title={
											drawerCard.pane.odinStarred
												? "Unstar"
												: "Star - pin to the top"
										}
										aria-label={drawerCard.pane.odinStarred ? "Unstar" : "Star"}
										aria-pressed={!!drawerCard.pane.odinStarred}
										onClick={() => toggleStar(drawerCard.pane.id)}
										className="shrink-0 rounded-[5px] px-1 text-[13px] text-attention hover:bg-attention/15"
									>
										{drawerCard.pane.odinStarred ? "★" : "☆"}
									</button>
								</div>
								{drawerCard.pane.type === "terminal" && !inCatchUp && (
									<button
										type="button"
										title="Show what this session changed (git diff)"
										onClick={() => {
											setIsShellOpen(false);
											setIsDiffOpen((open) => !open);
										}}
										className={cn(
											"shrink-0 rounded-md px-2 py-1 text-xs font-semibold",
											isDiffOpen
												? "bg-primary/15 text-primary"
												: "bg-secondary text-muted-foreground hover:text-foreground",
										)}
									>
										⑂ Diff
									</button>
								)}
								{/* Not in Catch up (nor Diff): you're deciding Next or Done. */}
								{drawerCard.pane.type === "terminal" && !inCatchUp && (
									// One control: the shell, and - once it's open - where it is.
									<div className="flex shrink-0 items-stretch">
										<button
											type="button"
											title={
												shellRunning
													? "This session already has a shell running - reattach to it"
													: drawerShell
														? "This session's shell is disconnected - open it to start a new one"
														: "Open a shell in this session's checkout"
											}
											onClick={() =>
												isShellOpen
													? setIsShellOpen(false)
													: openShell(drawerCard)
											}
											className={cn(
												"flex items-center gap-1.5 px-2 py-1 text-xs font-semibold",
												isShellOpen && drawerShell
													? "rounded-l-md"
													: "rounded-md",
												isShellOpen
													? "bg-primary/15 text-primary"
													: "bg-secondary text-muted-foreground hover:text-foreground",
											)}
										>
											❯ Shell
											{drawerShell && (
												<ShellDot
													card={drawerCard}
													shell={drawerShell}
													alive={shellRunning}
												/>
											)}
										</button>
										{isShellOpen && drawerShell && (
											<ShellPlaceMenu
												card={drawerCard}
												shell={drawerShell}
												shells={[
													...(shellPaneOf(drawerCard)
														? [["", shellPaneOf(drawerCard) as Pane] as const]
														: []),
													...drawerNamedShells,
												]}
												onSelectShell={(name) => setShellName(name || null)}
												onOpenInVsCode={(dir) =>
													void openInVsCode(drawerCard, dir)
												}
											/>
										)}
									</div>
								)}
								{!catchUpLean && (
									<button
										type="button"
										title="Toggle the session brief"
										onClick={() => setIsBriefOpen((open) => !open)}
										className={cn(
											"shrink-0 rounded-md px-2 py-1 text-xs font-semibold",
											isBriefOpen
												? "bg-primary/15 text-primary"
												: "bg-secondary text-muted-foreground hover:text-foreground",
										)}
									>
										ⓘ Brief
									</button>
								)}
								{!inCatchUp && (
									<button
										type="button"
										title="Toggle full width"
										onClick={() =>
											setDrawerFraction((fraction) => (fraction < 1 ? 1 : 0.6))
										}
										className="shrink-0 rounded-md bg-secondary px-2 py-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
									>
										⛶
									</button>
								)}
							</div>
						</div>
						{catchUpLean ? (
							<CatchUpCard
								card={drawerCard}
								title={cardTitle(drawerCard)}
								suggestion={catchUpSuggestionOf(drawerCard)}
								// Out of Catch up, onto this card's normal drawer.
								onShowSession={() => setCatchUp(null)}
							/>
						) : (
							/* terminal on the left, "what's going on" brief on the right */
							<div className="flex min-h-0 flex-1">
								{/* The other sessions in flight, one click away - no Minimize
								    and hunt for the card on the board. Hidden on a narrow
								    drawer, where the chat needs the room. */}
								{!inCatchUp &&
									switchCards.length + idleSwitchCards.length > 1 && (
										<nav
											aria-label="Sessions"
											className={cn(
												"hidden shrink-0 flex-col overflow-y-auto border-r border-border py-1.5 @3xl:flex",
												isSwitchListMin ? "w-8" : "w-[210px]",
											)}
										>
											<div className="mb-1 flex h-6 shrink-0 items-center">
												{!isSwitchListMin && (
													<button
														type="button"
														onClick={openComposerOnCurrentRepo}
														title="New session - describe a task and start an agent session, then open it here"
														className="ml-3 flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
													>
														<LuPlus className="size-3" />
														New session
													</button>
												)}
												<button
													type="button"
													title={
														isSwitchListMin
															? "Show session list"
															: "Minimize session list"
													}
													aria-label={
														isSwitchListMin
															? "Show session list"
															: "Minimize session list"
													}
													onClick={toggleSwitchList}
													className={cn(
														"flex h-6 min-w-0 flex-1 items-center text-muted-foreground hover:text-foreground",
														isSwitchListMin
															? "justify-center"
															: "justify-end px-2",
													)}
												>
													{isSwitchListMin ? (
														<LuChevronRight className="size-3.5" />
													) : (
														<LuChevronLeft className="size-3.5" />
													)}
												</button>
											</div>
											{!isSwitchListMin && (
												<div className="mb-1 flex items-center gap-1.5 px-3 text-[11px] text-muted-foreground">
													<select
														value={switchSort}
														onChange={(e) =>
															pickSwitchSort(e.target.value as SwitchSort)
														}
														aria-label="Sort sessions"
														title="Sort sessions"
														className="shrink-0 cursor-pointer rounded border border-border bg-card px-1 py-0.5 outline-none hover:text-foreground"
													>
														{Object.entries(SWITCH_SORTS).map(
															([value, label]) => (
																<option key={value} value={value}>
																	{label}
																</option>
															),
														)}
													</select>
													<button
														type="button"
														onClick={toggleSwitchGrouped}
														aria-pressed={isSwitchGrouped}
														title="Group by status"
														className={cn(
															"shrink-0 rounded border px-1 py-0.5 hover:text-foreground",
															isSwitchGrouped
																? "border-primary/50 bg-primary/15 text-foreground"
																: "border-border bg-card",
														)}
													>
														Group
													</button>
													<button
														type="button"
														onClick={() =>
															showTicks ? clearPicked() : setSelecting(true)
														}
														aria-pressed={showTicks}
														title="Select several sessions to resume, finish or park together (Esc to stop)"
														className={cn(
															"shrink-0 rounded border px-1 py-0.5 hover:text-foreground",
															showTicks
																? "border-primary/50 bg-primary/15 text-foreground"
																: "border-border bg-card",
														)}
													>
														Select
													</button>
													<span
														className="ml-auto min-w-0 truncate font-mono"
														title={`Previous session ${prevSessionKey} - next session ${nextSessionKey}`}
													>
														{prevSessionKey} {nextSessionKey}
													</span>
												</div>
											)}
											{!isSwitchListMin && pickedRowIds.length > 0 && (
												<div className="sticky top-0 z-10 mx-2 mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-primary/40 bg-secondary px-2 py-1 text-[11px] text-muted-foreground">
													<span className="font-semibold text-foreground">
														{pickedRowIds.length} selected
													</span>
													{pickedRowIds.length < switchRows.length && (
														<button
															type="button"
															title="Select every row shown"
															onClick={() =>
																setPickedIds(new Set(switchRowIds))
															}
															className="hover:text-foreground"
														>
															All {switchRows.length}
														</button>
													)}
													<button
														type="button"
														title="Clear the selection (Esc)"
														onClick={clearPicked}
														className="ml-auto hover:text-foreground"
													>
														Clear
													</button>
													<span className="basis-full" />
													<button
														type="button"
														disabled={resumablePicked.length === 0}
														title={
															resumablePicked.length
																? "Resume the closed and queued sessions selected - live ones are left alone"
																: "Nothing selected is closed or queued - live sessions are left alone"
														}
														onClick={resumePicked}
														className="flex items-center gap-1 hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
													>
														<LuPlay className="size-3" aria-hidden />
														Resume
													</button>
													<button
														type="button"
														title="Done - remove the selected sessions from the board"
														onClick={finishPicked}
														className="flex items-center gap-1 hover:text-success"
													>
														<span className="text-success">✓</span>
														Done
													</button>
													<button
														type="button"
														disabled={parkablePicked.length === 0}
														title={
															parkablePicked.length
																? "Park the selected sessions in Idle - they stay open, a running turn is stopped"
																: "Everything selected is already in Idle"
														}
														onClick={() => void parkPicked()}
														className="flex items-center gap-1 hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
													>
														<LuPause className="size-3" aria-hidden />
														Idle
													</button>
												</div>
											)}
											{switchCards.map((card, index) => (
												<Fragment key={card.pane.id}>
													{isSwitchGrouped &&
														card.status !== switchCards[index - 1]?.status &&
														(isSwitchListMin ? (
															index > 0 && (
																<div className="mx-2 my-1 border-t border-border" />
															)
														) : (
															<div className="mt-2 mb-0.5 px-3 text-[10px] font-semibold uppercase tracking-[.4px] text-muted-foreground">
																{PANE_STATUS[card.status].label}
															</div>
														))}
													{switchRow(card)}
												</Fragment>
											))}
											{idleSwitchCards.length > 0 &&
												(isSwitchListMin ? (
													isIdleSwitchOpen && (
														<div className="mx-2 my-1 border-t border-border" />
													)
												) : (
													<button
														type="button"
														onClick={toggleIdleSwitch}
														aria-expanded={isIdleSwitchOpen}
														className="mt-2 mb-0.5 flex items-center gap-1 px-3 text-left text-[10px] font-semibold uppercase tracking-[.4px] text-muted-foreground hover:text-foreground"
													>
														{isIdleSwitchOpen ? (
															<LuChevronDown className="size-3" />
														) : (
															<LuChevronRight className="size-3" />
														)}
														{PANE_STATUS.idle.label} ({idleSwitchCards.length})
													</button>
												))}
											{isIdleSwitchOpen &&
												idleSwitchCards.map((card) => (
													<Fragment key={card.pane.id}>
														{switchRow(card)}
													</Fragment>
												))}
										</nav>
									)}
								<div className="flex min-h-0 min-w-0 flex-1 flex-col">
									{isShellOpen && drawerShell ? (
										// A shell in the same checkout, mounted like any other pane -
										// it spawns on first mount with the session's cwd.
										<div className="flex min-h-0 flex-1 flex-col bg-background">
											<div className="flex items-center gap-2 border-b border-border px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[.4px] text-muted-foreground">
												{drawerNamedShells.length ? (
													// One tab per Shell: the main one, then each named one an agent ran.
													[
														...(shellPaneOf(drawerCard)
															? [["", shellPaneOf(drawerCard) as Pane] as const]
															: []),
														...drawerNamedShells,
													].map(([name, pane]) => (
														<button
															key={pane.id}
															type="button"
															onClick={() => setShellName(name || null)}
															className={cn(
																"rounded px-1.5 py-0.5 normal-case tracking-normal",
																pane.id === drawerShell.id
																	? "bg-primary/15 text-primary"
																	: "hover:text-foreground",
															)}
														>
															❯ {name || "Shell"}
														</button>
													))
												) : (
													<span className="rounded bg-primary/15 px-1.5 py-0.5 normal-case tracking-normal text-primary">
														❯ Shell
													</span>
												)}
												Your terminal - ❯ Shell again goes back to the session
											</div>
											<div className="min-h-0 flex-1 p-2">
												<Terminal
													key={drawerShell.id}
													paneId={drawerShell.id}
													tabId={drawerShell.tabId}
													workspaceId={drawerCard.workspaceId}
												/>
											</div>
										</div>
									) : isDiffOpen &&
										!inCatchUp &&
										drawerCard.pane.type === "terminal" ? (
										<DiffView
											key={drawerCard.pane.id}
											paneId={drawerCard.pane.id}
											cwd={sessionCwd(drawerCard.pane) ?? null}
											claudeSessionId={drawerCard.pane.claudeSessionId ?? null}
											workspaceId={drawerCard.workspaceId}
										/>
									) : drawerCard.pane.type !== "terminal" ? (
										<div className="flex-1 select-text cursor-text overflow-y-auto px-4 py-3 text-[12.5px] text-muted-foreground">
											{drawerCard.pane.cwd && (
												<div>cwd: {drawerCard.pane.cwd}</div>
											)}
											<div className="mt-2">
												Chat session - no terminal to embed.
											</div>
										</div>
									) : agentPaneIds.has(drawerCard.pane.id) &&
										chatView &&
										terminalPaneId !== drawerCard.pane.id ? (
										<ChatView
											key={drawerCard.pane.id}
											paneId={drawerCard.pane.id}
											sessionId={
												drawerCard.pane.claudeSessionId ??
												usePaneMeta.getState().sessionIdByPane[
													drawerCard.pane.id
												] ??
												null
											}
											cwd={sessionCwd(drawerCard.pane) ?? drawerCard.repoPath}
											workspaceId={drawerCard.workspaceId}
											working={isWorkingNow(drawerCard.pane.id)}
											onShowTerminal={() =>
												setTerminalPaneId(drawerCard.pane.id)
											}
											onStop={() => void interruptPane(drawerCard.pane.id)}
										/>
									) : agentPaneIds.has(drawerCard.pane.id) ? (
										// Claude running - the real PTY, attached read/write. xterm is the
										// only thing that renders Claude Code's full-screen TUI legibly
										// (scrollback replay is a stream of overlapping frames = mush).
										<div className="flex min-h-0 flex-1 flex-col bg-background p-2">
											<Terminal
												key={drawerCard.pane.id}
												paneId={drawerCard.pane.id}
												tabId={drawerCard.tabId}
												workspaceId={drawerCard.workspaceId}
											/>
										</div>
									) : resumingPaneIds.includes(drawerCard.pane.id) &&
										!panes[drawerCard.pane.id]?.odinQueued &&
										chatView ? (
										// Same slot and type as the ended view below, so its
										// ChatView stays mounted and your message stays on screen.
										<HistoryView card={drawerCard} live={false} resuming />
									) : resumingPaneIds.includes(drawerCard.pane.id) ||
										panes[drawerCard.pane.id]?.odinQueued ? (
										// Between the click and the PTY coming up, "Session ended"
										// history reads as if Resume did nothing. A queued task has
										// no history at all yet - it's waiting for a free slot.
										<StartingView
											label={
												resumingPaneIds.includes(drawerCard.pane.id)
													? panes[drawerCard.pane.id]?.odinQueued
														? "Starting session…"
														: "Resuming session…"
													: `Waiting to start - ${panes[drawerCard.pane.id]?.odinQueued?.reason}`
											}
											onStartOnMac={
												panes[drawerCard.pane.id]?.odinQueued?.remote?.prompt &&
												!resumingPaneIds.includes(drawerCard.pane.id)
													? () => {
															const pane = panes[drawerCard.pane.id];
															if (pane)
																void resumeCard({ ...drawerCard, pane });
														}
													: undefined
											}
										/>
									) : (
										// Claude has exited - the PTY is dead, or a bare zsh outlived
										// the conversation. Show the conversation, read-only.
										<HistoryView
											card={drawerCard}
											live={false}
											onDo={(text) => void resumeCard(drawerCard, false, text)}
										/>
									)}
								</div>
								{isBriefOpen && (
									<SessionBrief
										key={drawerCard.pane.id}
										paneId={drawerCard.pane.id}
										cwd={drawerCard.pane.cwd ?? null}
										claudeSessionId={drawerCard.pane.claudeSessionId ?? null}
										marker={cardTitle(drawerCard)}
										live={alivePaneIds.has(drawerCard.pane.id)}
										launch={drawerCard.pane.odinBrief}
										starting={
											!!panes[drawerCard.pane.id]?.odinQueued ||
											resumingPaneIds.includes(drawerCard.pane.id) ||
											drawerCard.pane.status === "working"
										}
									/>
								)}
							</div>
						)}
						<div className="flex gap-2 border-t border-border px-4 py-3">
							{drawerCard.pane.type === "terminal" && (
								<button
									type="button"
									disabled={
										resumingPaneIds.includes(drawerCard.pane.id) ||
										!!panes[drawerCard.pane.id]?.odinQueued?.remote ||
										isWorkingNow(drawerCard.pane.id) ||
										isSettledAgent(drawerCard.pane.id)
									}
									onClick={() => {
										// Catch up's lean card hides the terminal - resuming there
										// left you staring at "Working…" with the session out of view.
										if (inCatchUp) setCatchUpFull(drawerCard.pane.id);
										const pane = panes[drawerCard.pane.id];
										void resumeCard(
											pane ? { ...drawerCard, pane } : drawerCard,
										);
									}}
									title={
										panes[drawerCard.pane.id]?.odinQueued?.remote
											? "Waiting for room on the remote host - starting there now could take its other sessions down"
											: isWorkingNow(drawerCard.pane.id)
												? "Already working - resuming would kill the running turn"
												: isSettledAgent(drawerCard.pane.id)
													? "Session is already open - type in the terminal"
													: agentPaneIds.has(drawerCard.pane.id)
														? 'Session is open - send it "Continue"'
														: drawerCard.pane.status === "working"
															? 'Died mid-turn - reopen it and send "Continue"'
															: "Reopen this conversation at an idle prompt (claude --resume)"
									}
									className={cn(
										"rounded-[7px] px-3 py-1.5 text-xs font-semibold",
										BUTTON.primary,
										// The gradient is a background-image, so it has to go before
										// bg-secondary can show - otherwise disabled stays violet.
										"disabled:cursor-not-allowed disabled:bg-none disabled:bg-secondary disabled:text-faint-foreground disabled:shadow-none disabled:ring-1 disabled:ring-inset disabled:ring-border disabled:hover:brightness-100",
									)}
								>
									{/* The live pane: a Resume queued from this drawer leaves
									    drawerCard's snapshot without the flag. */}
									{panes[drawerCard.pane.id]?.odinQueued
										? resumingPaneIds.includes(drawerCard.pane.id)
											? "▶ Starting…"
											: "▶ Start now"
										: resumingPaneIds.includes(drawerCard.pane.id)
											? "↻ Resuming…"
											: isWorkingNow(drawerCard.pane.id)
												? "↻ Working…"
												: // Resume already landed and Claude is up - the button
													// writes "Continue" into the open prompt. A live PTY with
													// no Claude in it (Ctrl+C'd out) still says Resume.
													agentPaneIds.has(drawerCard.pane.id)
													? "↻ Continue"
													: "↻ Resume"}
								</button>
							)}
							{/* The drawer keeps Esc for itself, so a turn needs its own stop:
							    Ctrl+C, which stops Claude mid-turn. Only while working - at
							    an idle prompt a second Ctrl+C quits Claude. The chat view's
							    composer has this same stop, so it shows in Terminal View only. */}
							{drawerCard.pane.type === "terminal" &&
								(!chatView || terminalPaneId === drawerCard.pane.id) && (
									<button
										type="button"
										disabled={!isWorkingNow(drawerCard.pane.id)}
										title={
											isWorkingNow(drawerCard.pane.id)
												? "Stop the agent (sends Ctrl+C to the session)"
												: "Nothing to interrupt - the agent isn't working"
										}
										onClick={() => void interruptPane(drawerCard.pane.id)}
										className={cn(
											"rounded-[7px] px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50",
											BUTTON.secondary,
										)}
									>
										■ Interrupt
									</button>
								)}
							{/* Back from Terminal View: out of a question peek, or the
							    setting itself when the terminal is the choice. */}
							{drawerCard.pane.type === "terminal" &&
								(!chatView || terminalPaneId === drawerCard.pane.id) && (
									<button
										type="button"
										title="Show sessions as a chat (Settings > Appearance)"
										onClick={() =>
											chatView ? setTerminalPaneId(null) : setChatView(true)
										}
										className={cn(
											"flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-xs font-semibold",
											BUTTON.secondary,
										)}
									>
										<LuMessageSquare className="size-3.5" />
										Chat View
									</button>
								)}
							{/* Done, Remind and Minimize sit right; RemindButton wraps its button
							    in a span, so the gap is a spacer rather than ml-auto. */}
							<div className="flex-1" />
							{/* Catch up has its own ✓ Done and ‹ below and above the card. */}
							{!inCatchUp && (
								<button
									type="button"
									onClick={() => markDoneInDrawer(drawerCard)}
									title="Done - end the session and remove it from the board"
									className={cn(
										"rounded-[7px] px-3 py-1.5 text-xs font-semibold",
										BUTTON.done,
									)}
								>
									✓ Done
								</button>
							)}
							<RemindButton
								onPick={(day) => remindMe(drawerCard, day)}
								label="Remind me"
								className={cn(
									"rounded-[7px] px-3 py-1.5 text-xs font-semibold",
									BUTTON.remind,
								)}
							/>
							{!inCatchUp && (
								<button
									type="button"
									onClick={() => setDrawerCard(null)}
									className={cn(
										"rounded-[7px] px-3 py-1.5 text-xs font-semibold",
										BUTTON.secondary,
									)}
								>
									Minimize Session
								</button>
							)}
							<button
								type="button"
								aria-label="More session actions"
								title="Everything the board card's right-click menu has: star, restart, ping me, Remote Control, save as doc, tags"
								onClick={(event) => {
									const box = event.currentTarget.getBoundingClientRect();
									setTagMenu({
										paneId: drawerCard.pane.id,
										x: box.right - 220,
										// TagMenu keeps itself on screen, so it opens above the footer.
										y: box.top,
									});
								}}
								className={cn(
									"rounded-[7px] px-2.5 py-1.5 text-xs font-semibold",
									BUTTON.secondary,
								)}
							>
								⋯
							</button>
						</div>
					</div>
				</>
			)}

			{lostCard && (
				<OdinPromptDialog
					heading="That conversation is gone"
					note={`Claude kept no transcript for "${cardTitle(lostCard)}", so there is nothing to resume. Start a new session from its brief instead?`}
					defaultPrompt={lostCardPrompt(lostCard)}
					placeholder="What should the new session pick up?"
					onCancel={() => setLostCard(null)}
					onSubmit={(prompt, images) =>
						startOverFromLost(lostCard, prompt, images)
					}
				/>
			)}

			{isComposerOpen && (
				<OdinPromptDialog
					heading="New Session"
					placeholder="What should the agent do? (it picks the repo)"
					repoPicker
					defaultRepo={composerRepo}
					modelPicker
					backlogToggle
					wherePicker
					onCancel={() => setIsComposerOpen(false)}
					onSubmit={handleNewSession}
				/>
			)}
		</div>
	);
}
