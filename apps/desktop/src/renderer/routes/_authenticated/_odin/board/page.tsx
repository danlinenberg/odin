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
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { IconType } from "react-icons";
import {
	LuCircleCheck,
	LuClock,
	LuEye,
	LuEyeOff,
	LuFlame,
	LuGitMerge,
	LuGitPullRequest,
	LuHourglass,
	LuMoon,
	LuPause,
	LuPlay,
	LuRepeat,
	LuTerminal,
} from "react-icons/lu";
import { SiJira, SiNotion, SiSlack } from "react-icons/si";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { startQueuedPane } from "renderer/hooks/useTaskQueue";
import { useHotkey } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { emojify } from "renderer/lib/emoji";
import { canClaimKeyboard } from "renderer/lib/keyboard";
import { coldRestoreState } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/state";
import { Terminal } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/Terminal";
import * as terminalCache from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache";
import { useIdleClose } from "renderer/stores/idle-close";
import { launchLimits, useLaunchLimits } from "renderer/stores/launch-limits";
import { useSessionView } from "renderer/stores/session-view";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane, PaneStatus } from "renderer/stores/tabs/types";
import { lastAgentHookAt } from "renderer/stores/tabs/useAgentHookListener";
import { boardColumn } from "shared/board-column";
import {
	type BoardSection,
	bySection,
	SECTION_LABEL,
} from "shared/board-section";
import { duplicateSessions } from "shared/duplicate-sessions";
import { claimedCheckout, launchBlocker } from "shared/launch-gate";
import { sessionUsageLabel } from "shared/machine-load";
import { profileOf } from "shared/odin-profile";
import {
	agentOnScreen,
	escIsHandledOnScreen,
	odinScreenStatus,
	odinScreenWrite,
} from "shared/odin-screen-status";
import { BOARD_TAGS, boardTags, normalizeTag } from "shared/odin-tags";

/** Tags the card shows as their own pill instead of in the #tag line. */
const PILL_TAGS = ["automation", "auto-started", "off-hours"];

import { openUrl, useInAppBrowser } from "renderer/stores/in-app-browser";
import { DropHint } from "../components/DropHint";
import { useSearchHotkey } from "../components/FeedChrome";
import {
	cardBody,
	OdinPromptDialog,
	type PromptImage,
	sessionTitle,
	untruncatedTitle,
} from "../components/OdinPromptDialog";
import { PersonChip, personColor } from "../components/PersonChip";
import { BUTTON, PILL } from "../components/pill";
import { DueChip, OverdueMark, useReminders } from "../components/Reminders";
import { TranscriptView } from "../components/TranscriptView";
import { useBacklogReview, useReview } from "../hooks/useBacklogReview";
import { endSession } from "../hooks/useDone";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useOdinProfile } from "../hooks/useOdinProfile";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { usePendingFocus } from "../hooks/usePendingFocus";
import {
	QUESTION_TAG,
	useQuickQuestionDialog,
} from "../hooks/useQuickQuestion";
import { PANE_STATUS } from "../pane-status";
import { sessionFor } from "../review/verdicts";
import type { BriefMessage } from "./brief";
import {
	actionItems,
	elapsedLabel,
	jiraIssue,
	lastMessageAt,
	launchPullRequest,
	linkRefs,
	mergeCheckUrls,
	mergeReady,
	mergeTargets,
	nextCronFire,
	notionPage,
	onlyLookLeft,
	onlyMergeLeft,
	prsDropped,
	pullRequests,
	reviewEnded,
	reviewedPullRequest,
	sourceLink,
} from "./brief";
import { ChatView } from "./ChatView";
import { DiffView } from "./DiffView";
import { NextInLine } from "./NextInLine";
import { HoverBrief, SessionBrief } from "./SessionBrief";
import {
	PREFIX as REMIND_PREFIX,
	RemindButton,
	remindSession,
	SessionReminders,
} from "./SessionReminders";

/**
 * The same marks the feed tabs use, so a section header reads as its source at
 * a glance. Kept here rather than in shared/board-section - that module is
 * imported by the main process, which has no business loading React icons.
 */
const SECTION_ICON: Record<BoardSection, IconType> = {
	// Not a source - its turn ended in the last JUST_DONE_MS.
	recent: LuCircleCheck,
	// Not a source - a task that exists but hasn't started.
	queued: LuHourglass,
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

// ponytail: "permission" (blocked on a prompt) and "failed" are the same call
// to action - one column. "review" is not: it finished and wants nothing.
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
function HistoryView({ card, live }: { card: BoardCard; live: boolean }) {
	const sessionId = useCardSessionId(card);
	// Same query the card's pills run, so this is a cache hit. Claude prunes old
	// transcripts; when the file is gone, the saved screen is all that's left.
	const { error } = useCardTranscript(card, false);
	const chatView = useSessionView((s) => s.chat);
	if (sessionId && !live && !error && chatView) {
		return (
			<ChatView
				paneId={card.pane.id}
				sessionId={sessionId}
				cwd={sessionCwd(card.pane) ?? card.repoPath}
				workspaceId={card.workspaceId}
			/>
		);
	}
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

/** The conversation behind a card, for the pills that read it. */
function useCardSessionId(card: BoardCard): string | null {
	const mirrored = usePaneMeta((s) => s.sessionIdByPane[card.pane.id]);
	// ponytail: no findClaudeSession fallback - that's an extra query per card to
	// serve only pre-claudeSessionId panes. They get no pill; open the card.
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
	onShowSession,
}: {
	card: BoardCard;
	/** The board's title for it - finds the transcript of a session with no id. */
	title: string;
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
	const label = "mb-1.5 text-[11px] font-semibold uppercase tracking-[.4px]";
	return (
		<div className="flex min-h-0 flex-1 select-text cursor-text flex-col gap-6 overflow-y-auto px-8 py-7">
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
 *
 * ponytail: tasks match by title here, not by the task's pane id; pass the
 * task map if a renamed task card ever misses its verdict.
 */
function useDropFor(pane: Pane | undefined) {
	return useReview((review) =>
		pane && !pane.odinTags?.includes("auto-started")
			? review.swept.find(
					(r) =>
						r.verdict === "DROP" &&
						sessionFor(r, [pane], new Map()) === pane.id,
				)
			: undefined,
	);
}

function DropPill({ pane }: { pane: Pane }) {
	const row = useDropFor(pane);
	return row ? <DropHint evidence={row.evidence} /> : null;
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

/** Whether a worktree has a shell in it: live (named), left there and gone, or none. */
function ShellsDot({ live, dead }: { live: string[]; dead: number }) {
	const others = live.filter((what) => what !== "this shell").length;
	const mine = live.length > others;
	const [title, label, dot] = live.length
		? [
				live.join("\n"),
				mine
					? others
						? `this shell + ${others}`
						: "this shell"
					: `${others} live`,
				"bg-working",
			]
		: dead
			? [
					`${dead} Odin shell${dead === 1 ? "" : "s"} left here whose process has died`,
					"disconnected",
					"bg-danger",
				]
			: ["No terminal is in this worktree", "no shell", "ring-1 ring-input"];
	return (
		<span
			title={title}
			className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"
		>
			<span className={cn("inline-block size-[6px] rounded-full", dot)} />
			{label}
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
	const panes = useTabsStore((s) => s.panes);
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
	/** Live shells sitting in `root`, and Odin panes left there whose PTY is gone. */
	/**
	 * In `root` itself - a worktree checked out under it (`.worktrees/x`) is its
	 * own checkout, not the clone's.
	 * ponytail: the two worktree folders Odin and Claude Code use; anything else
	 * nested counts as the clone until this reads each cwd's `.git`.
	 */
	const inCheckout = (dir: string | null | undefined, root: string) =>
		inside(dir, root) &&
		!/^\/(?:\.claude\/)?\.?worktrees\//.test(
			(dir as string).slice(root.length),
		);
	/** Live terminals sitting in `root`, each named, and Odin panes left there whose PTY is gone. */
	const shellsIn = (root: string) => {
		const liveHere = live
			.filter((session) => inCheckout(cwds?.[session.pid], root))
			.map((session) => {
				if (session.paneId === shell.id) return "this shell";
				const pane = panes[session.paneId];
				if (pane?.odinTaskTitle) return `agent session: ${pane.odinTaskTitle}`;
				const owner = Object.values(panes).find(
					(p) => p.odinShellPaneId === session.paneId,
				);
				if (owner?.odinTaskTitle) return `shell of: ${owner.odinTaskTitle}`;
				return session.busy
					? "terminal, running something"
					: "terminal, idle at its prompt";
			});
		const livePanes = new Set(live.map((session) => session.paneId));
		const dead = Object.values(panes).filter(
			(pane) =>
				pane.type === "terminal" &&
				!livePanes.has(pane.id) &&
				inCheckout(pane.cwd ?? pane.initialCwd, root),
		);
		return { live: liveHere, dead: dead.length };
	};
	const workplaces = [
		...(data?.pullRequests ?? []).map((pr) => pr.worktree),
		data?.worktree,
		data?.checkout,
	].filter((dir): dir is string => !!dir);
	const atWork = workplaces.some((root) => inCheckout(here, root));
	return { data, here, inside: inCheckout, shellsIn, atWork };
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
 * Where the shell is, and a menu to move it into the session's work. The
 * shell opens where the session launched - for feed sessions the catch-all
 * directory - while the agent cd'd into a worktree the shell never saw.
 */
function ShellPlaceMenu({ card, shell }: { card: BoardCard; shell: Pane }) {
	const { data, here, inside, shellsIn } = useShellPlace(card, shell);
	const write = electronTrpc.terminal.write.useMutation();
	const updatePaneCwd = useTabsStore((s) => s.updatePaneCwd);
	const cd = (dir: string) => {
		write.mutate({
			paneId: shell.id,
			data: `cd '${dir.replaceAll("'", "'\\''")}'\r`,
		});
		updatePaneCwd(shell.id, dir, false);
	};
	const basename = (dir: string) => dir.split("/").pop() || dir;
	// Every place this session's work lives: its PRs' worktrees, then the
	// checkout it worked in when no PR already covers it.
	const targets = (data?.pullRequests ?? []).map((pr) => ({
		key: pr.url,
		dir: pr.worktree,
		badge: `#${pr.number}`,
		name: pr.isMain ? "main checkout" : basename(pr.worktree),
		repo: pr.repo,
	}));
	const checkout = data?.worktree ?? data?.checkout;
	if (checkout && !targets.some((target) => target.dir === checkout)) {
		targets.push({
			key: checkout,
			dir: checkout,
			badge: "",
			name: basename(checkout),
			repo: data?.name ?? "",
		});
	}
	const current = targets.find((target) => inside(here, target.dir));
	const where = here?.replace(/^\/Users\/[^/]+/, "~");
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					title={where ? `Shell is in ${where} - move it` : "Move this shell"}
					className="flex min-w-0 max-w-[200px] items-center gap-1 rounded-r-md border-l border-background bg-secondary px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
				>
					<span className="truncate">
						{current ? current.name : here ? basename(here) : "…"}
					</span>
					<span className="text-[9px] opacity-70">▾</span>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-80">
				<DropdownMenuLabel className="truncate text-[10px] font-normal text-muted-foreground">
					{where
						? `Shell is in ${where}${current ? "" : " - outside this session's work"}`
						: "This shell's location is unknown"}
				</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{targets.length === 0 && (
					<div className="px-2 py-1.5 text-xs text-muted-foreground">
						No worktree known for this session yet
					</div>
				)}
				{targets.map((target) => (
					<DropdownMenuItem
						key={target.key}
						title={target.dir}
						onSelect={() => cd(target.dir)}
						className="flex items-center gap-2 text-xs"
					>
						<span className="w-3 text-primary">
							{target === current ? "✓" : ""}
						</span>
						<span className="w-12 shrink-0 font-semibold tabular-nums">
							{target.badge}
						</span>
						<span className="flex min-w-0 flex-col">
							<span className="truncate">{target.name}</span>
							<span className="truncate text-[10px] text-muted-foreground">
								{target.repo}
							</span>
						</span>
						<ShellsDot {...shellsIn(target.dir)} />
					</DropdownMenuItem>
				))}
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
function TagMenu({
	x,
	y,
	tags,
	allTags,
	customTags,
	starred,
	onStar,
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
	/** Set when the sweep suggests dropping this session. */
	onKeep?: () => void;
	onToggle: (tag: string) => void;
	onAdd: (tag: string) => void;
	onForget: (tag: string) => void;
	onClose: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [draft, setDraft] = useState("");

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

	// Keep the menu on screen near the edges.
	const left = Math.min(x, window.innerWidth - 240);
	const top = Math.min(y, window.innerHeight - 320);

	return (
		<div
			ref={ref}
			style={{ left, top }}
			className="fixed z-[60] w-[220px] rounded-[10px] border border-border bg-card p-2 shadow-[0_10px_30px_rgba(0,0,0,.5)]"
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
			<div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[.4px] text-muted-foreground">
				Tags
			</div>
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
	// A card whose conversation Claude no longer has. Resume stops and puts this
	// here; the dialog it opens asks whether to start over from the card's brief.
	const [lostCard, setLostCard] = useState<BoardCard | null>(null);
	const [drawerCard, setDrawerCard] = useState<BoardCard | null>(null);
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
	const chatView = useSessionView((s) => s.chat);
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: isBriefOpen is a trigger - the brief resizes the terminal
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
	}, [drawerCard, utils, isBriefOpen]);

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
			// Mid-rename, Esc abandons the rename - not the drawer.
			if (renameDraft !== null) setRenameDraft(null);
			else setDrawerCard(null);
		};
		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () =>
			window.removeEventListener("keydown", onKeyDown, { capture: true });
	}, [drawerCard, renameDraft]);

	const focusedAt = useFocusedAt();
	// ponytail: in-memory "in this status since" per pane; resets on reload
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
				{ retry: false, staleTime: 60_000, refetchInterval: 60_000 },
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
	// Needs-you sessions, open or closed, and the state of every PR they linked.
	// Once each is approved the card is Done: what's left is a click, not a
	// decision. Closed ones count - the approval usually lands after the session
	// went quiet, and a card closed for idling keeps its Needs you column. The
	// transcripts are the ones the cards' own pills already fetch.
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
		return column === "permission"
			? [{ paneId: pane.id, sessionId, live: !!alive, brief: pane.odinBrief }]
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
				},
			);
		}),
	);
	const candidateKey = (
		test: (
			messages: BriefMessage[],
			states: Parameters<typeof mergeReady>[1] | undefined,
			brief: string | null | undefined,
		) => boolean,
	) =>
		mergeCandidates
			.filter(({ brief }, i) => {
				const messages = mergeTranscripts[i]?.data?.messages;
				return !!messages && test(messages, mergeStateQueries[i]?.data, brief);
			})
			.map(({ paneId }) => paneId)
			.join(",");
	const mergeReadyKey = candidateKey(
		(messages, states, brief) =>
			onlyLookLeft(messages) ||
			(!!states &&
				(mergeReady(messages, states) ||
					prsDropped(messages, states) ||
					!!reviewEnded(reviewedPullRequest(brief, messages), states))),
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
	const droppedPaneIds = useMemo(
		() => new Set(droppedKey ? droppedKey.split(",") : []),
		[droppedKey],
	);
	/**
	 * Needs you, unless all it needs is merging approved PRs or a look at what
	 * shipped, or its PRs were closed - then Done.
	 */
	const withMergeReady = useCallback(
		(column: PaneStatus, paneId: string): PaneStatus =>
			column === "permission" && mergeReadyPaneIds.has(paneId)
				? "review"
				: column,
		[mergeReadyPaneIds],
	);
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
	// Close sessions that have sat idle past Settings → Sessions' idle timeout: an open Claude holds
	// memory and a checkout for a conversation Resume can reopen any time. The
	// card stays in its column (odinClosedIn) - closing it answered nothing.
	// A session whose shell is still running something (a dev server) is in use.
	// ponytail: a pane with no odinStatusAt (launched before it existed) starts
	// its clock when this board first sees it.
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
			if (!agentPaneIds.has(pane.id) || loopingPaneIds.has(pane.id))
				return false;
			if (pane.status === "working" || pane.odinQueued) return false;
			if (!firstSeenRef.current.has(pane.id))
				firstSeenRef.current.set(pane.id, now);
			const since =
				pane.odinStatusAt ?? firstSeenRef.current.get(pane.id) ?? now;
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
			const shell = pane.odinShellPaneId;
			if (shell && alivePaneIds.has(shell) && busyShells.has(shell)) continue;
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
	// ponytail: a pane without a claudeSessionId isn't tracked.
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
		const check = () => {
			const screen = visibleScreen(drawerPaneId);
			if (!screen.trim()) return; // not mounted yet - nothing to judge
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
		check();
		const id = setInterval(check, 1_500);
		return () => clearInterval(id);
	}, [drawerPaneId, alivePaneIds]);

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
						const screen = (
							result?.snapshot?.snapshotAnsi ??
							result?.scrollback ??
							""
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
	const [customTags, setCustomTags] = useState<string[]>(() => {
		try {
			return JSON.parse(localStorage.getItem("odin:custom-tags") ?? "[]");
		} catch {
			return [];
		}
	});
	const saveCustomTags = (next: string[]) => {
		setCustomTags(next);
		try {
			localStorage.setItem("odin:custom-tags", JSON.stringify(next));
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
	/**
	 * Open a shell where this session is working. The pane is remembered on the
	 * session, so closing the drawer and coming back reattaches to that shell
	 * (with its history) instead of leaving a new one behind every time.
	 */
	const openShell = async (card: BoardCard) => {
		if (!shellPaneOf(card)) {
			// Open where the work is - the PR's worktree - not where it launched.
			const sessionId =
				card.pane.claudeSessionId ??
				usePaneMeta.getState().sessionIdByPane[card.pane.id];
			const repo = sessionId
				? await utils.repos.workingRepoName
						.fetch({ claudeSessionId: sessionId }, { staleTime: 60_000 })
						.catch(() => null)
				: null;
			const { paneId } = useTabsStore.getState().addTab(card.workspaceId, {
				initialCwd: repo?.worktree ?? repo?.checkout ?? sessionCwd(card.pane),
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
	const drawerShell = drawerCard ? shellPaneOf(drawerCard) : undefined;
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
				const column = withMergeReady(
					boardColumn(
						status,
						// `undefined` = the poll hasn't answered yet, which is not "dead".
						daemonSessions === undefined ? undefined : alive,
						pane.odinParked ?? false,
						loopingPaneIds.has(pane.id),
						pane.odinClosedIn,
					),
					pane.id,
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

	// Write the session briefs in the background, so opening a card shows one
	// straight away rather than starting a 15s model call while you wait. The
	// main process queues them one at a time and skips anything still cached, so
	// re-firing this is cheap.
	const warmBriefs =
		electronTrpc.terminal.warmClaudeSessionBriefs.useMutation();
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

	/** A quick question is no card, but its answer still opens in the drawer. */
	const questionCard = (paneId: string): BoardCard | undefined => {
		const pane = panes[paneId];
		const tab = tabs.find((t) => t.id === pane?.tabId);
		if (!pane?.odinTags?.includes(QUESTION_TAG) || !tab) return undefined;
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: openDrawer and questionCard are new each render; the pending pane and the cards are the trigger
	useEffect(() => {
		if (!pendingPaneId) return;
		const card =
			[...cardsByStatus.values()]
				.flat()
				.concat(completedCards)
				.find((c) => c.pane.id === pendingPaneId) ??
			questionCard(pendingPaneId);
		if (card) {
			openDrawer(card);
			clearPendingFocus();
		}
	}, [pendingPaneId, cardsByStatus, completedCards, clearPendingFocus]);

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
	 * Type "Continue" at a live agent's prompt. Text and Enter go in separate
	 * writes: claude's TUI reads a chunk ending in a newline as a paste and
	 * inserts it instead of submitting.
	 */
	const sendContinue = async (paneId: string) => {
		await terminalWrite.mutateAsync({ paneId, data: "Continue" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		await terminalWrite.mutateAsync({ paneId, data: "\r" });
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
	 * otherwise hold its own checkout. A failed read lets it through.
	 */
	const resumeBlocker = async (pane: Pane, cwd: string | undefined) => {
		try {
			return launchBlocker(
				await utils.client.resourceMetrics.getSnapshot.query(),
				Object.values(useTabsStore.getState().panes).filter(
					(other) => other.id !== pane.id,
				),
				pane.odinCwd ??
					claimedCheckout(undefined, cwd ?? "", workConfig?.odinRepoPath),
				workConfig?.odinRepoPath,
				launchLimits(useLaunchLimits.getState()),
			);
		} catch {
			return null;
		}
	};

	/**
	 * Park a Resume in Queued; useTaskQueue runs `command` when the gate clears.
	 * The drawer stays put: it shows the wait and its ▶ Start now.
	 */
	const queueResume = (pane: Pane, command: string, reason: string) => {
		useTabsStore.setState((state) => ({
			panes: {
				...state.panes,
				[pane.id]: {
					...state.panes[pane.id],
					status: "idle",
					odinParked: false,
					interrupted: false,
					completed: false,
					odinQueued: { command, reason },
				},
			},
		}));
	};

	/** Ctrl+C the turn. Shared by the drawer's Interrupt and the chat's stop. */
	const interruptPane = (paneId: string) => {
		utils.client.terminal.write.mutate({ paneId, data: "\x03" });
		// Claude fires no Stop hook on an interrupt, so the card would read
		// Working until the scan - and a second click would land Ctrl+C at the
		// idle prompt and start quitting it. Same as Park.
		useTabsStore.setState((state) => ({
			panes: {
				...state.panes,
				[paneId]: { ...state.panes[paneId], status: "idle" },
			},
		}));
	};

	const resumeCard = async (card: BoardCard, auto = false) => {
		if (resumingPaneIds.includes(card.pane.id)) return;
		// Never started: there's no conversation to resume, only the launch that
		// was held back. Run it now - that's what "Start now" meant on the toast
		// this queue replaced.
		if (card.pane.odinQueued) {
			setResumingPaneIds((ids) => [...ids, card.pane.id]);
			try {
				await startQueuedPane(utils.client, card.pane);
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
		if (isWorkingNow(card.pane.id)) {
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
		if (agentPaneIds.has(card.pane.id) && !shellOnScreen) {
			if (!auto) openDrawer(card);
			const blocker = await resumeBlocker(card.pane, sessionCwd(card.pane));
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
					`cd '${cwd}' && claude --dangerously-skip-permissions --resume ${id} Continue`,
					blocker,
				);
				return;
			}
			try {
				await sendContinue(card.pane.id);
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
		// No opening prompt: Resume reopens the conversation at an idle prompt,
		// it doesn't put the agent back to work. Deciding what happens next is
		// the whole reason you came back to the session. Except mid-turn: that
		// agent comes back with the job half done, so "Continue" rides on the
		// command line. Typing it in once the TUI looked up raced Claude's boot
		// - the write was swallowed and the card needed another Resume click.
		const resumeCmd = `${
			sessionId
				? `claude --dangerously-skip-permissions --resume ${sessionId}`
				: "claude --dangerously-skip-permissions --continue"
		}${diedWorking ? " Continue" : ""}`;
		// You resumed it to work in it - bring it up. The drawer swaps its
		// read-only history for the live terminal once the PTY is back, and that
		// terminal takes the keyboard. Auto-resume never steals the screen.
		if (!auto) openDrawer(card);
		// Only a Resume that goes back to work waits on the gate. One reopening
		// at an idle prompt takes no working slot and holds no checkout - queuing
		// it parked you behind every task in line, looking at the board.
		const blocker = diedWorking ? await resumeBlocker(card.pane, cwd) : null;
		if (blocker) {
			queueResume(
				card.pane,
				cwd ? `cd '${cwd}' && ${resumeCmd}` : resumeCmd,
				blocker,
			);
			setResumingPaneIds((ids) => ids.filter((id) => id !== card.pane.id));
			return;
		}
		try {
			// Free the pane (dead or a live cold-restored shell) so the respawn
			// re-runs the command. Ignore errors - pane may already be dead.
			await terminalKill.mutateAsync({ paneId: card.pane.id }).catch(() => {});
			await new Promise((resolve) => setTimeout(resolve, 300));
			await utils.client.terminal.createOrAttach.mutate({
				paneId: card.pane.id,
				tabId: card.tabId,
				workspaceId: card.workspaceId,
				cwd,
				command: cwd ? `cd '${cwd}' && ${resumeCmd}` : resumeCmd,
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
			// ponytail: no toast on the happy path - the card renders its own
			// "resuming…" spinner, and a toast over the board hides other cards.
			// Only the ambiguous --continue fallback is worth interrupting for.
			if (!sessionId) {
				toast.info(
					"Resuming latest session in this repo (no session id found)",
				);
			}
			// Don't sit on the stale poll for up to 5s - ask now so the card leaves
			// Idle as soon as the PTY exists.
			void utils.terminal.listDaemonSessions.invalidate();
			// ponytail: fixed timeout, not a retry loop - if the respawned claude
			// dies on startup the pane never goes alive, and a stuck spinner would
			// cost the card its Resume button for good.
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
	 * One card at a time so each launch-gate check sees the last one's slot.
	 */
	// ponytail: once per pane per app run - a session that dies again on
	// startup keeps its Resume button instead of looping.
	const autoResumedRef = useRef(new Set<string>());
	const resumeCardRef = useRef(resumeCard);
	resumeCardRef.current = resumeCard;
	// Covers the transcript check before resumeCard marks the card resuming.
	const autoResumingRef = useRef(false);
	// Re-runs the pick when a resume ends without touching any other dep
	// (lost transcript, queued behind the gate).
	const [autoResumeTick, setAutoResumeTick] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: autoResumeTick is the re-run trigger
	useEffect(() => {
		if (
			!daemonSessions ||
			resumingPaneIds.length > 0 ||
			autoResumingRef.current
		)
			return;
		const card = (cardsByStatus.get("idle") ?? []).find(
			(c) =>
				c.pane.status === "working" &&
				!c.pane.odinQueued &&
				!alivePaneIds.has(c.pane.id) &&
				!autoResumedRef.current.has(c.pane.id),
		);
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
		cardsByStatus,
		resumingPaneIds,
		autoResumeTick,
	]);

	const handleNewSession = async (
		rawPrompt: string,
		images: PromptImage[],
		repoPath: string,
	) => {
		const prompt = rawPrompt.trim();
		if (!prompt && images.length === 0) return;
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
		});
		setIsComposerOpen(false);
		if (result.ok) {
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
		const title = cardTitle(card);
		const brief = card.pane.odinBrief ?? briefByPane[card.pane.id] ?? null;
		return brief?.trim() && brief.trim() !== title
			? `${title}\n\n${brief.trim()}`
			: title;
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
		setDrawerCard(null);
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
	 * can't make that true. A running turn is interrupted first (Esc) - a card
	 * sitting in Idle while its agent works would be a lie.
	 */
	const parkCard = async (card: BoardCard) => {
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
			await terminalWrite
				.mutateAsync({ paneId: card.pane.id, data: "\x1b" })
				.catch(() => {});
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
		toast.success("Parked in Idle - session still open", undoAction(undo));
	};

	/**
	 * Done = end it and off the board. removePane kills the PTY and drops the
	 * pane (and its tab, when it's the only one). There used to be a separate
	 * Kill button; it did the same thing minus the cleanup - the card left the
	 * board either way and the orphaned pane/tab stayed behind forever. Session
	 * History resumes finished sessions from Claude's transcripts on disk, so
	 * keeping the dead pane bought nothing. To stop an agent without ending the
	 * session, drag the card to Idle (Park) instead.
	 */
	const markDone = (card: BoardCard) => {
		const undo = endCard(card);
		setDrawerCard(null);
		toast.success("Done - removed from board", undoAction(undo));
	};

	/**
	 * Done, undoable: the PTY dies with the pane, so undo resumes the same
	 * conversation (`claude --resume`) into a fresh pane, like Session History.
	 */
	const endCard = (card: BoardCard) => {
		const sessionId =
			card.pane.claudeSessionId ??
			usePaneMeta.getState().sessionIdByPane[card.pane.id];
		const cwd = sessionCwd(card.pane) ?? card.repoPath;
		const title = cardTitle(card);
		const brief = usePaneMeta.getState().briefByPane[card.pane.id];
		endSession(card.pane.id);
		if (!sessionId) return;
		return pushUndo(async () => {
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

	// ponytail: in-memory, this board mount only - a reload forgets it.
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

	/** Done now; on `day` it pings and waits above the columns to be resumed. */
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
		markDone(card);
		toast.success(`Reminding you ${day} - ${title.slice(0, 50)}`);
	};

	return (
		<div className="flex h-full flex-col">
			{/* One header row: title, launcher, filter dropdown. */}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-[18px] pb-2 pt-2.5">
				<h1 className="text-[15px] font-semibold">Dev Board</h1>
				<button
					type="button"
					title="Describe a task and start an agent session"
					onClick={() => setIsComposerOpen(true)}
					className={cn(
						"rounded-lg px-2.5 py-1 text-[12px] font-semibold transition-colors",
						BUTTON.primary,
					)}
				>
					+ New Session
				</button>
				<button
					type="button"
					title="Ask a Claude that's already running - no start-up wait (⌘⇧I)"
					onClick={() => useQuickQuestionDialog.getState().setOpen(true)}
					className={cn(
						"rounded-lg px-2.5 py-1 text-[12px] font-semibold transition-colors",
						BUTTON.secondary,
					)}
				>
					Quick question
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
						"ml-auto flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium",
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
				</button>
			</div>

			<SessionReminders />

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
					onStar={() =>
						useTabsStore.setState((state) => ({
							panes: {
								...state.panes,
								[tagMenu.paneId]: {
									...state.panes[tagMenu.paneId],
									odinStarred: !state.panes[tagMenu.paneId]?.odinStarred,
								},
							},
						}))
					}
					onToggle={(tag) => toggleTag(tagMenu.paneId, tag)}
					onClose={() => setTagMenu(null)}
				/>
			)}

			<div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-[18px] pb-[18px] pt-1">
				{COLUMNS.map((column) => {
					const cards = cardsByStatus.get(column.status) ?? [];
					// ponytail: re-sorted on the board's next render, not on the
					// minute the 10m runs out - the pane polls re-render it often.
					const sections = bySection(
						cards,
						(card) =>
							(column.status === "review" || column.status === "permission") &&
							justDoneLeft(
								statusSinceRef.current.get(card.pane.id)?.at,
								focusedAt,
							) > 0,
					);
					// One section is just the column - don't label it, unless it's
					// Parked: "you put these down" is worth saying on its own.
					const labelled =
						sections.length > 1 ||
						sections[0]?.[0] === "recent" ||
						sections[0]?.[0] === "parked" ||
						sections[0]?.[0] === "queued";
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
								"relative flex min-w-[240px] flex-1 flex-col overflow-hidden rounded-xl border bg-tertiary/85 bg-[linear-gradient(to_bottom,color-mix(in_oklab,var(--col)_9%,transparent),transparent_160px)]",
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
											const queue = sections.flatMap(([, group]) => group);
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
									{cards.length}
								</span>
							</div>
							<div className="flex flex-col gap-2 overflow-y-auto px-2 pt-0.5 pb-2.5">
								{cards.length === 0 ? (
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
													<HoverCard key={card.pane.id} openDelay={350}>
														<HoverCardTrigger asChild>
															{/* biome-ignore lint/a11y/useSemanticElements: a real <button> can't nest the reply <input>, so the card is a div with button semantics */}
															<div
																role="button"
																tabIndex={0}
																draggable
																onDragStart={(event) => {
																	event.dataTransfer.setData(
																		"text/plain",
																		card.pane.id,
																	);
																	event.dataTransfer.effectAllowed = "move";
																}}
																onDragEnd={() => setDragOverIdle(false)}
																onKeyDown={(event) => {
																	if (
																		event.key === "Enter" ||
																		event.key === " "
																	) {
																		openDrawer(card);
																	}
																}}
																onClick={() => openDrawer(card)}
																onContextMenu={(event) => {
																	// Right-click → star or tag this session.
																	event.preventDefault();
																	setTagMenu({
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
																		{card.pane.odinStarred && (
																			<span
																				title="Starred"
																				className="mr-1 text-attention"
																			>
																				★
																			</span>
																		)}
																		<OverdueMark
																			itemKey={`session:${card.pane.id}`}
																		/>
																		{cardTitle(card)}
																	</div>
																	<button
																		type="button"
																		title="Done - remove from the board"
																		onClick={(event) => {
																			event.stopPropagation();
																			markDone(card);
																		}}
																		className="shrink-0 rounded-[5px] px-1.5 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-success/15 hover:text-success group-hover:opacity-100"
																	>
																		✓ done
																	</button>
																	<RemindButton
																		onPick={(day) => remindMe(card, day)}
																		className="rounded-[5px] px-1.5 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-attention/15 hover:text-attention group-hover:opacity-100"
																	/>
																</div>
																{/* Facts are one grey text line; chips are left only for flags that ask
    something of you. A pill that renders nothing drops out, so the dots
    between the rest stay right. */}
																<div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11.5px] text-muted-foreground [&>*+*]:before:inline-block [&>*+*]:before:mr-1.5 [&>*+*]:before:text-faint-foreground [&>*+*]:before:content-['·']">
																	{(droppedPaneIds.has(card.pane.id) ||
																		reviewMergedPaneIds.has(card.pane.id)) && (
																		<span className="font-medium text-danger">
																			{reviewMergedPaneIds.has(card.pane.id)
																				? "Dropped: PR merged"
																				: "Dropped: PR closed"}
																		</span>
																	)}
																	{cardContact(card) && (
																		<span className="inline-flex min-w-0 items-center gap-1 font-medium text-soft-foreground">
																			<span
																				className="size-1.5 shrink-0 rounded-full"
																				style={{
																					backgroundColor: personColor(
																						cardContact(card) as string,
																					).fg,
																				}}
																			/>
																			<span className="truncate">
																				{cardContact(card)}
																			</span>
																		</span>
																	)}
																	<RepoPill card={card} />
																	<PrPill
																		card={card}
																		live={card.status === "working"}
																	/>
																	<NotionPill
																		card={card}
																		live={card.status === "working"}
																	/>
																	<AgePill
																		card={card}
																		live={card.status === "working"}
																		fallback={
																			statusSinceRef.current.get(card.pane.id)
																				?.at
																		}
																	/>
																</div>
																<DropPill pane={card.pane} />
																<DuplicateHint
																	other={duplicateOf.get(card.pane.id)}
																	titleOf={cardTitle}
																/>
																<div className="mt-1 flex flex-wrap items-center gap-1.5">
																	<ReviewPill card={card} />
																	<MergeOnlyPill card={card} />
																	{(card.status === "review" ||
																		card.status === "permission") && (
																		<JustDonePill
																			focusedAt={focusedAt}
																			since={
																				statusSinceRef.current.get(card.pane.id)
																					?.at
																			}
																		/>
																	)}
																	{boardTags(
																		card.pane.odinTags,
																		customTags,
																	).some((tag) => !PILL_TAGS.includes(tag)) && (
																		<span className="font-mono text-[10.5px] text-faint-foreground">
																			{boardTags(card.pane.odinTags, customTags)
																				.filter(
																					(tag) => !PILL_TAGS.includes(tag),
																				)
																				.map((tag) => `#${tag}`)
																				.join(" ")}
																		</span>
																	)}
																	{boardTags(
																		card.pane.odinTags,
																		customTags,
																	).includes("automation") && (
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
																	{card.pane.odinTags?.includes(
																		"off-hours",
																	) && (
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
																	{card.pane.odinTags?.includes(
																		"auto-started",
																	) && (
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
																	{agentPaneIds.has(card.pane.id) && (
																		<LoopPill card={card} />
																	)}
																	<LoadPill card={card} />
																	{shellPaneOf(card) && daemonSessions && (
																		<ShellChip
																			shellPaneId={shellPaneOf(card)?.id ?? ""}
																			alive={alivePaneIds.has(
																				shellPaneOf(card)?.id ?? "",
																			)}
																		/>
																	)}
																	{/* Last, and blank until you set one: a deadline is yours, not
	    something the session reports about itself. */}
																	<DueChip
																		itemKey={`session:${card.pane.id}`}
																		title={cardTitle(card)}
																	/>
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
																{/* ponytail: the "Needs you"/"Final Review" headers already say
															    the rest - only a failure adds anything. pane.status is
															    the raw one; the column merges prompts and failures. */}
																{card.status === "permission" &&
																	card.pane.status === "failed" && (
																		<div className="mt-1.5 text-xs text-danger">
																			✗ failed - click to see what broke
																		</div>
																	)}
																{card.status === "idle" &&
																	!agentPaneIds.has(card.pane.id) &&
																	resumingPaneIds.includes(card.pane.id) && (
																		<div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-working">
																			<span className="size-[9px] animate-spin rounded-full border border-working border-t-transparent" />
																			{card.pane.odinQueued
																				? "starting…"
																				: "resuming…"}
																		</div>
																	)}
																{/* Never started - it's waiting on the machine, not
																    on you. Says what for, and lets you overrule it. */}
																{card.pane.odinQueued &&
																	!resumingPaneIds.includes(card.pane.id) && (
																		<div className="mt-1.5 flex items-center gap-2">
																			<span className="text-[11.5px] text-attention">
																				⏳ {card.pane.odinQueued.reason}
																			</span>
																			<button
																				type="button"
																				title="Start this session now, gate or no gate"
																				onClick={(event) => {
																					event.stopPropagation();
																					void resumeCard(card);
																				}}
																				className={cn(
																					"ml-auto shrink-0 whitespace-nowrap rounded-[7px] px-2.5 py-1 text-xs font-semibold",
																					BUTTON.secondary,
																				)}
																			>
																				Start now
																			</button>
																		</div>
																	)}
																{card.status === "idle" &&
																	!card.pane.odinQueued &&
																	!agentPaneIds.has(card.pane.id) &&
																	!resumingPaneIds.includes(card.pane.id) && (
																		<div className="mt-1.5 flex items-center gap-2">
																			{/* ponytail: the button says "resume" - only a
																		    failure is worth spelling out. */}
																			{card.pane.status === "failed" && (
																				<span className="text-[11.5px] text-danger">
																					✗ failed
																				</span>
																			)}
																			{/* Resume does more here than on the other
																		    cards - it puts the agent back to work
																		    instead of handing you a prompt. */}
																			{card.pane.status === "working" && (
																				<span className="text-[11.5px] text-attention">
																					⏸ died mid-turn
																				</span>
																			)}
																			<button
																				type="button"
																				onClick={(event) => {
																					event.stopPropagation();
																					void resumeCard(card);
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
															<CardHoverContent
																card={card}
																text={cardText(card)}
															/>
														</HoverCardContent>
													</HoverCard>
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
					{inCatchUp && catchUp && (
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
									title="Leave it on the board and go to the next one"
									onClick={() => catchUpNext(false)}
									className={cn(
										"flex-1 rounded-2xl py-3.5 text-[15px] font-semibold",
										BUTTON.secondary,
									)}
								>
									Next
								</button>
								<button
									type="button"
									title="Done - remove it from the board and go to the next one"
									onClick={() => catchUpNext(true)}
									className={cn(
										"flex-1 rounded-2xl py-3.5 text-[15px] font-semibold",
										BUTTON.done,
									)}
								>
									✓ Done
								</button>
							</div>
						</>
					)}
					{/* absolute, not fixed: it fills the content area, which starts below
					    the top bar. A top-0 fixed drawer put its title under the macOS
					    traffic lights, and the native buttons eat the click. */}
					<div
						className={cn(
							"absolute z-50 flex flex-col bg-tertiary",
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
						<div className="border-b border-border px-4 py-3.5">
							<div className="flex items-center gap-2">
								{renameDraft === null ? (
									<button
										type="button"
										title="Click to rename this session"
										onClick={() => setRenameDraft(cardTitle(drawerCard))}
										className="min-w-0 flex-1 truncate text-left text-sm font-semibold hover:text-primary"
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
								{drawerCard.pane.type === "terminal" && !inCatchUp && (
									<button
										type="button"
										title="Show what this session changed (git diff, rendered by delta)"
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
											<ShellPlaceMenu card={drawerCard} shell={drawerShell} />
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
							<div className="mt-1.5 flex flex-wrap gap-1.5">
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
							</div>
						</div>
						{catchUpLean ? (
							<CatchUpCard
								card={drawerCard}
								title={cardTitle(drawerCard)}
								// Out of Catch up, onto this card's normal drawer.
								onShowSession={() => setCatchUp(null)}
							/>
						) : (
							/* terminal on the left, "what's going on" brief on the right */
							<div className="flex min-h-0 flex-1">
								<div className="flex min-h-0 min-w-0 flex-1 flex-col">
									{isShellOpen && drawerShell ? (
										// A shell in the same checkout, mounted like any other pane -
										// it spawns on first mount with the session's cwd.
										<div className="min-h-0 flex-1 bg-background p-2">
											<Terminal
												key={drawerShell.id}
												paneId={drawerShell.id}
												tabId={drawerShell.tabId}
												workspaceId={drawerCard.workspaceId}
											/>
										</div>
									) : isDiffOpen &&
										!inCatchUp &&
										drawerCard.pane.type === "terminal" ? (
										<DiffView
											key={drawerCard.pane.id}
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
											waiting={
												panes[drawerCard.pane.id]?.status === "permission"
											}
											onShowTerminal={() =>
												setTerminalPaneId(drawerCard.pane.id)
											}
											onStop={() => interruptPane(drawerCard.pane.id)}
										/>
									) : agentPaneIds.has(drawerCard.pane.id) ? (
										// Claude running - the real PTY, attached read/write. xterm is the
										// only thing that renders Claude Code's full-screen TUI legibly
										// (scrollback replay is a stream of overlapping frames = mush).
										<div className="flex min-h-0 flex-1 flex-col bg-background p-2">
											{chatView && (
												<button
													type="button"
													onClick={() => setTerminalPaneId(null)}
													className="mb-1 self-start text-[12px] text-link hover:underline"
												>
													← Back to chat
												</button>
											)}
											<Terminal
												key={drawerCard.pane.id}
												paneId={drawerCard.pane.id}
												tabId={drawerCard.tabId}
												workspaceId={drawerCard.workspaceId}
											/>
										</div>
									) : resumingPaneIds.includes(drawerCard.pane.id) ? (
										// Between the click and the PTY coming up, "Session ended"
										// history reads as if Resume did nothing.
										<div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-working">
											<span className="size-[12px] animate-spin rounded-full border-2 border-working border-t-transparent" />
											{drawerCard.pane.odinQueued
												? "Starting session…"
												: "Resuming session…"}
										</div>
									) : (
										// Claude has exited - the PTY is dead, or a bare zsh outlived
										// the conversation. Show the conversation, read-only.
										<HistoryView card={drawerCard} live={false} />
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
										isWorkingNow(drawerCard.pane.id)
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
							    an idle prompt a second Ctrl+C quits Claude. */}
							{drawerCard.pane.type === "terminal" && (
								<button
									type="button"
									disabled={!isWorkingNow(drawerCard.pane.id)}
									title={
										isWorkingNow(drawerCard.pane.id)
											? "Stop the agent (sends Ctrl+C to the session)"
											: "Nothing to interrupt - the agent isn't working"
									}
									onClick={() => interruptPane(drawerCard.pane.id)}
									className={cn(
										"rounded-[7px] px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50",
										BUTTON.secondary,
									)}
								>
									■ Interrupt
								</button>
							)}
							{/* Done, Remind and Minimize sit right; RemindButton wraps its button
							    in a span, so the gap is a spacer rather than ml-auto. */}
							<div className="flex-1" />
							{/* Catch up has its own ✓ Done and ‹ below and above the card. */}
							{!inCatchUp && (
								<button
									type="button"
									onClick={() => markDone(drawerCard)}
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
					onCancel={() => setIsComposerOpen(false)}
					onSubmit={handleNewSession}
				/>
			)}
		</div>
	);
}
