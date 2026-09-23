import type { SelectProject, SelectWorkspace } from "@odin/local-db";
import { BRIEF_DIR } from "@odin/shared/constants";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@odin/ui/hover-card";
import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { IconType } from "react-icons";
import {
	LuClock,
	LuFlame,
	LuFolderGit2,
	LuGitPullRequest,
	LuHourglass,
	LuPause,
	LuRepeat,
	LuTerminal,
} from "react-icons/lu";
import { SiJira, SiNotion, SiSlack } from "react-icons/si";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { startQueuedPane } from "renderer/hooks/useTaskQueue";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { emojify } from "renderer/lib/emoji";
import { canClaimKeyboard } from "renderer/lib/keyboard";
import { coldRestoreState } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/state";
import { Terminal } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/Terminal";
import * as terminalCache from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane, PaneStatus } from "renderer/stores/tabs/types";
import { lastAgentHookAt } from "renderer/stores/tabs/useAgentHookListener";
import { boardColumn } from "shared/board-column";
import {
	type BoardSection,
	bySection,
	SECTION_LABEL,
} from "shared/board-section";
import { sessionUsageLabel } from "shared/machine-load";
import { profileOf } from "shared/odin-profile";
import {
	agentOnScreen,
	escIsHandledOnScreen,
	odinScreenStatus,
	odinScreenWrite,
} from "shared/odin-screen-status";
import { BOARD_TAGS, boardTags } from "shared/odin-tags";
import {
	cardBody,
	OdinPromptDialog,
	type PromptImage,
	sessionTitle,
	untruncatedTitle,
} from "../components/OdinPromptDialog";
import { PersonChip } from "../components/PersonChip";
import { DueChip, useReminders } from "../components/Reminders";
import { useOdinProfile } from "../hooks/useOdinProfile";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { PANE_STATUS } from "../pane-status";
import {
	elapsedLabel,
	lastMessageAt,
	nextCronFire,
	notionPage,
	pullRequests,
	sourceLink,
} from "./brief";
import { DiffView } from "./DiffView";
import { SessionBrief } from "./SessionBrief";

/**
 * The same marks the feed tabs use, so a section header reads as its source at
 * a glance. Kept here rather than in shared/board-section — that module is
 * imported by the main process, which has no business loading React icons.
 */
const SECTION_ICON: Record<BoardSection, IconType> = {
	// Not a source — a task that exists but hasn't started.
	queued: LuHourglass,
	// Not a source — a session you put down on purpose.
	parked: LuPause,
	slack: SiSlack,
	reactions: SiSlack,
	jira: SiJira,
	pr: LuGitPullRequest,
	notion: SiNotion,
	// Not from a feed — a session you opened yourself.
	normal: LuTerminal,
};

export const Route = createFileRoute("/_authenticated/_odin/board/")({
	component: DevBoardPage,
});

/**
 * Dev Board — kanban over live agent state, styled per the agreed mock.
 * Columns are the pane statuses the app already tracks; cards jump to the
 * pane; the input launches a new agent session into the selected workspace.
 */

// ponytail: "permission" (blocked on a prompt) and "failed" are the same call
// to action — one column. "review" is not: it finished and wants nothing.
const COLUMNS: { status: PaneStatus; label: string }[] = [
	{ status: "working", label: "Working" },
	{ status: "permission", label: "Needs you" },
	// Turn ended clean, no prompt on screen — nothing to do but ✓ done it.
	{ status: "review", label: "Done" },
	// Statuses reset to idle on app reload (upstream can't trust them), but the
	// PTYs live on in the daemon — alive-but-idle sessions land here instead of
	// vanishing from the board.
	{ status: "idle", label: "Idle" },
];

interface BoardCard {
	pane: Pane;
	tabId: string;
	tabName: string;
	workspaceId: string;
	/** The workspace's own checkout — where a card with no pane cwd runs. */
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
 * terminal mounts (seeded there, then confirmed by OSC-7) — until someone opens
 * the session, the repo picked at launch lives only in `initialCwd`.
 */
function sessionCwd(pane: Pane): string | undefined {
	return pane.cwd ?? pane.initialCwd ?? undefined;
}

/**
 * The checkout a card runs in, in one word. Feed-launched sessions have no
 * repo of their own — they run in the workspace's checkout, so name that.
 */
function repoLabel(card: BoardCard): string {
	return (sessionCwd(card.pane) ?? card.repoPath).split("/").pop() || "repo";
}

/** Same slug rule as useLaunchTaskSession — to locate a task's prompt file. */
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
 * real sessions that is over a minute — a test run, a subagent, a big search.
 * Every one of those gaps handed a mid-turn card to the scan below.
 */
const SETTLED_MS = 120_000;

/** Width of the Odin icon rail in layout.tsx — the drawer stops here. */
const RAIL_W = 52;

/** Widest the drawer goes: everything except the icon rail. */
function maxDrawerWidth(): number {
	const w = typeof window !== "undefined" ? window.innerWidth : 1600;
	return Math.max(w - RAIL_W, 480);
}

/** Default session-drawer width: full width up to the sidebar. */
const defaultDrawerWidth = maxDrawerWidth;

// Built via string escapes — ANSI sequences are control chars by definition
const ANSI_RE =
	/\x1b\[[0-9;?<>]*[a-zA-Z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]|[\x00-\x08\x0b-\x1f]/g;
/**
 * Read-only transcript for a dead pane (killed or previous-run). Reads the
 * persisted scrollback from disk — which survives daemon death and restarts —
 * so closed sessions still show their history without respawning anything.
 */
function HistoryView({ card, live }: { card: BoardCard; live: boolean }) {
	// Read the persisted scrollback from disk — always reliable, unlike the
	// embedded xterm which intermittently renders blank in this drawer. Poll
	// while the session is live so the transcript stays current.
	const { data, isLoading } = electronTrpc.terminal.readHistory.useQuery(
		{ paneId: card.pane.id, workspaceId: card.workspaceId },
		live ? { refetchInterval: 1500 } : undefined,
	);
	const ref = useRef<HTMLDivElement>(null);
	const text = (data?.scrollback ?? "").replace(ANSI_RE, "");
	useEffect(() => {
		if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
	}, [text]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="border-b border-[#25252e] px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[.4px] text-[#8a8a97]">
				{live
					? "Session transcript · live"
					: "Conversation history · session ended"}
			</div>
			<div
				ref={ref}
				className="min-h-0 flex-1 select-text cursor-text overflow-y-auto whitespace-pre-wrap break-words bg-[#0a0a0c] px-4 py-3 font-mono text-[11.5px] leading-relaxed text-[#d6d6dc]"
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
	// ponytail: no findClaudeSession fallback — that's an extra query per card to
	// serve only pre-claudeSessionId panes. They get no pill; open the card.
	return card.pane.claudeSessionId ?? mirrored ?? null;
}

/**
 * "This one shipped a PR" — the fact you scan the board for, on the card
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

function PrPill({ card, live }: { card: BoardCard; live: boolean }) {
	const { data } = useCardTranscript(card, live);
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const prs = data ? pullRequests(data.messages) : [];
	const pr = prs[0];
	if (!pr) return null;
	return (
		<button
			type="button"
			title={prs.length > 1 ? `${prs.length} PRs — newest: ${pr.url}` : pr.url}
			onClick={(event) => {
				// The card itself opens the drawer; the pill opens GitHub.
				event.stopPropagation();
				openUrl.mutate(pr.url);
			}}
			className="rounded-[5px] bg-[#14301f] px-[7px] text-[11px] font-medium text-[#3ecf8e] hover:bg-[#1a3d28]"
		>
			PR #{pr.number}
			{prs.length > 1 ? ` +${prs.length - 1}` : ""}
		</button>
	);
}

function NotionPill({ card, live }: { card: BoardCard; live: boolean }) {
	const { data } = useCardTranscript(card, live);
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const page = data ? notionPage(data.messages) : null;
	if (!page) return null;
	return (
		<button
			type="button"
			title={page.title ?? page.url}
			onClick={(event) => {
				// The card itself opens the drawer; the pill opens Notion.
				event.stopPropagation();
				openUrl.mutate(page.url);
			}}
			className="rounded-[5px] bg-[#232329] px-[7px] text-[11px] font-medium text-[#d6d6dc] hover:bg-[#2c2c34]"
		>
			Notion
		</button>
	);
}

/**
 * Which repo this card's work landed in.
 *
 * The pane only records where it was launched, and every feed-started session
 * launches in the same catch-all directory — so the old label read `dev` on
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
			className="inline-flex items-center gap-1 rounded-[5px] bg-[#1b2430] px-[7px] text-[11px] font-medium text-[#7ec4ff]"
		>
			<LuFolderGit2 className="size-3 shrink-0" aria-hidden />
			{data?.name ?? repoLabel(card)}
		</span>
	);
}

/**
 * How long this card has been sitting — measured from the last message in the
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
			className="rounded-[5px] bg-[#1f1f27] px-[7px] text-[11px] text-[#a5a5b3]"
		>
			{label === "now" ? label : `${label} ago`}
		</span>
	);
}

/**
 * This session is running under `/loop` — it will wake itself up again, so an
 * idle card isn't done. Read from the schedule calls in its transcript; only
 * asked of a session whose claude is still running, since the schedule dies
 * with it.
 */
function LoopPill({ card }: { card: BoardCard }) {
	const { data, refetch } = useCardTranscript(card, true);
	// The schedule is booked at the very end of a turn — re-read as the card
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
		.join(" — ");
	return (
		<span
			title={`Under /loop — ${next}${loop.prompt ? `\n${loop.prompt}` : ""}`}
			className="inline-flex items-center gap-1 rounded-[5px] bg-[#2e2413] px-[7px] text-[11px] font-medium text-[#f5b83d]"
		>
			<LuRepeat className="size-3" aria-hidden />
			{countdown
				? `loop · ${countdown === "now" ? "<1m" : `in ${countdown}`}`
				: "loop"}
		</span>
	);
}

/**
 * The badge that answers "which of these is eating the Mac". The header chip
 * already says nine sessions hold 11 GB; this says which three of them do.
 *
 * Same snapshot the chip reads — one query, shared by every card through the
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
			className="inline-flex items-center gap-1 rounded-[5px] bg-[#2a1f12] px-[7px] text-[11px] font-medium tabular-nums text-[#f5b83d]"
		>
			<LuFlame className="size-3 shrink-0" aria-hidden />
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
	// The launch-time brief is usually just the title — don't repeat it.
	const summary =
		text ?? (known && known.trim() !== title.trim() ? known : fileBrief);

	return (
		<div className="flex flex-col gap-2">
			<div className="whitespace-pre-wrap break-words text-[13px] font-semibold text-[#f5f5f7]">
				{title}
			</div>
			{contact && <PersonChip name={contact} />}
			{summary && (
				<div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-[#d4d4dc]">
					{summary}
				</div>
			)}
		</div>
	);
}

/**
 * Right-click menu for a session card: star it, and the board's tags to toggle.
 * Positioned at the cursor; closes on Escape or click-outside.
 *
 * ponytail: no "new tag" field — the list is closed (shared/odin-tags), and a
 * typed one-off tag was how the vocabulary sprawled in the first place.
 */
function TagMenu({
	x,
	y,
	tags,
	allTags,
	starred,
	onStar,
	onToggle,
	onClose,
}: {
	x: number;
	y: number;
	tags: string[];
	allTags: string[];
	starred: boolean;
	onStar: () => void;
	onToggle: (tag: string) => void;
	onClose: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);

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
	const top = Math.min(y, window.innerHeight - 290);

	return (
		<div
			ref={ref}
			style={{ left, top }}
			className="fixed z-[60] w-[220px] rounded-[10px] border border-[#25252e] bg-[#16161b] p-2 shadow-[0_10px_30px_rgba(0,0,0,.5)]"
		>
			<button
				type="button"
				onClick={() => {
					onStar();
					onClose();
				}}
				className="mb-1.5 flex w-full items-center gap-2 rounded-md border-b border-[#25252e] px-1.5 pb-2 pt-1 text-left text-[12px] text-[#a5a5b3] transition-colors hover:text-[#f5c542]"
			>
				<span className="w-3 text-[#f5c542]">★</span>
				{starred ? "Unstar" : "Star"}
			</button>
			<div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[.4px] text-[#8a8a97]">
				Tags
			</div>
			<div className="flex max-h-[180px] flex-col overflow-y-auto">
				{allTags.map((tag) => {
					const on = tags.includes(tag);
					return (
						<button
							key={tag}
							type="button"
							onClick={() => onToggle(tag)}
							className={cn(
								"flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors",
								on ? "text-[#a394ff]" : "text-[#a5a5b3] hover:text-[#f5f5f7]",
							)}
						>
							<span className="w-3">{on ? "✓" : ""}</span>#{tag}
						</button>
					);
				})}
			</div>
		</div>
	);
}

/**
 * Stamp each card with the tags its brief came back with. The model picks
 * them while writing the brief that every card already gets, so this costs
 * no extra model call — it only carries the answer over to the pane.
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
 * Rename cards from the brief the model wrote for them — on, that is, when the
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
	const tabs = useTabsStore((state) => state.tabs);
	const panes = useTabsStore((state) => state.panes);
	// No workspace picker — one workspace in practice, and it listed confusing
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
	// An <a> would navigate the app window; the ticket opens in a browser.
	const openUrl = electronTrpc.external.openUrl.useMutation();
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
	// Prefer the task title captured at launch — Claude Code's OSC title rewrites
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
	// The full message behind an auto-renamed (or first-line) title — hover only.
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
	// Rename a session. Same home as tags (the pane, in app-state.json) and the
	// first thing cardTitle reads, so the new name shows everywhere and sticks.
	// Non-null = the drawer's title is being edited.
	const [renameDraft, setRenameDraft] = useState<string | null>(null);
	// The ticket (or PR) this session was launched from — the drawer's title says
	// "CRR-862: …" and until now there was no way to open CRR-862.
	const drawerLink = drawerCard ? sourceLink(drawerCard.pane.odinBrief) : null;
	// Open wide by default — a session needs room to read the terminal.
	const [drawerWidth, setDrawerWidth] = useState(defaultDrawerWidth);
	// The brief panel: open by default, because "what did I walk into?" is the
	// question you have every single time you open a session.
	const [isBriefOpen, setIsBriefOpen] = useState(true);
	// The diff takes the terminal's place rather than a side panel — a diff needs
	// the width, and you read one instead of watching the session, not alongside.
	const [isDiffOpen, setIsDiffOpen] = useState(false);
	// A plain shell in the session's checkout. Takes the terminal's place for the
	// same reason the diff does — you go to the shell instead of the session.
	const [isShellOpen, setIsShellOpen] = useState(false);
	// Panes whose Resume is in flight. Resuming takes a second (session lookup,
	// kill, respawn) and the card can't flip out of Idle until the 5s daemon
	// poll sees the new PTY — without this the click looks like it did nothing.
	const [resumingPaneIds, setResumingPaneIds] = useState<string[]>([]);

	const startDrawerResize = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const onMove = (move: PointerEvent) => {
			const width = window.innerWidth - move.clientX;
			setDrawerWidth(Math.min(Math.max(width, 480), maxDrawerWidth()));
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	// The cached xterm can mount into the drawer with stale dimensions (its
	// gated refit can miss), clipping the bottom of the screen — where Claude
	// renders its pickers. Nudge it: refit, sync the PTY size (SIGWINCH makes
	// Claude repaint at the new size), and pin the view to the bottom.
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
	// terminal by default — an Esc in the PTY cancels Claude's pending menu and
	// trips upstream's "user interrupted → idle" status heuristic. The
	// exceptions below are the states where Esc already means something to
	// whatever is on screen, and there it's handed back.
	useEffect(() => {
		if (!drawerCard) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// A box opened over the pane cancels itself on Esc. Captured this
			// early we'd swallow that keypress and close the drawer out from
			// under it instead, so hand the key back and leave the drawer alone.
			if ((event.target as HTMLElement | null)?.closest("[role=dialog]"))
				return;
			// Same rule for Claude's own menus: standing in a picker that says
			// "Esc to go back", Esc belongs to the picker, not to the drawer.
			// Read the mounted xterm rather than the scan's cached status — the
			// scan runs on a 3s timer and a menu opens and closes inside that.
			if (
				event.target instanceof HTMLElement &&
				event.target.closest(".xterm") &&
				escIsHandledOnScreen(visibleScreen(drawerCard.pane.id))
			)
				return;
			event.preventDefault();
			event.stopImmediatePropagation();
			// Mid-rename, Esc abandons the rename — not the drawer.
			if (renameDraft !== null) setRenameDraft(null);
			else setDrawerCard(null);
		};
		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () =>
			window.removeEventListener("keydown", onKeyDown, { capture: true });
	}, [drawerCard, renameDraft]);

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

	// A parked session that started moving again isn't parked any more — drop the
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

	// Live PTYs in the daemon — lets the board show sessions that survived an
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
	// Panes whose PTY is alive but has no agent in it — Ctrl+C out of Claude and
	// the shell outlives the conversation. Filled in by the screen scan below.
	const [agentGonePaneIds, setAgentGonePaneIds] = useState<string[]>([]);
	/**
	 * PTY alive AND Claude still running in it. This — not the raw daemon poll —
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
	// uses, so it's one fetch per session. Between ticks they belong in Idle —
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
	/** Alive PTY currently mid-turn — the one state Resume must not touch. */
	const isWorkingNow = (paneId: string) =>
		agentPaneIds.has(paneId) && panes[paneId]?.status === "working";
	// Drop the "resuming…" flag once the poll actually sees the new PTY — that's
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
	// already holds the screen — read it directly, with the same two-reads rule.
	const drawerPaneId = drawerCard?.pane.id;
	useEffect(() => {
		if (!drawerPaneId || !alivePaneIds.has(drawerPaneId)) return;
		const check = () => {
			const screen = visibleScreen(drawerPaneId);
			if (!screen.trim()) return; // not mounted yet — nothing to judge
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
	// but they go missing — Stop doesn't fire on Ctrl+C, a notification can miss
	// a pane that wasn't in the store yet, and statuses reset to idle on reload
	// while the PTYs live on. Any of those strands a card mid-flight ("Working"
	// forever on a session that's been sitting at its prompt for an hour), so
	// re-read every live board session on a timer instead of once.
	const setPaneStatusFromStore = useTabsStore((state) => state.setPaneStatus);
	const readingRef = useRef(new Set<string>());
	/** Panes whose last scan read the idle prompt — see the write below. */
	const sawIdlePromptRef = useRef(new Set<string>());
	/** Panes whose last scan found no Claude on screen — same doubt, same fix. */
	const sawNoAgentRef = useRef(new Set<string>());
	const lastScanRef = useRef(0);
	useEffect(() => {
		const scan = () => {
			// `panes` changes on every status write, which re-runs this effect and
			// would otherwise re-read every screen again straight away.
			if (Date.now() - lastScanRef.current < 3_000) return;
			lastScanRef.current = Date.now();
			for (const pane of Object.values(panes)) {
				// You parked it — don't let screen-reading drag it back out of Idle.
				if (pane.odinParked) continue;
				// Nothing to read: a queued task has no process yet.
				if (pane.odinQueued) continue;
				// The hooks and this scan are two writers to one status, and while a
				// turn is running the hooks rewrite it every few seconds. Reading the
				// screen in between only has to be wrong once for the card to flip
				// Working → Needs you → Working. So don't arbitrate: the hooks win
				// while they're live, and this steps in once a status has gone quiet
				// — which is the only case it exists for, because a hook that never
				// arrives leaves the card stuck for hours, not for seconds.
				// Quiet means the *hooks* have stopped talking, not that the status
				// stopped changing. They aren't the same thing: setPaneStatus no-ops
				// on an unchanged value, so a turn's worth of "working" hooks never
				// moves `statusSince` — which left this scan re-reading the screen of
				// every live session every 5 seconds, all turn, and a single bad read
				// bounced the card to Needs you until the next hook bounced it back.
				const since = Math.max(
					statusSinceRef.current.get(pane.id)?.at ?? 0,
					lastAgentHookAt.get(pane.id) ?? 0,
				);
				if (Date.now() - since < SETTLED_MS) continue;
				// Board sessions only — never attach to a terminal the board doesn't own.
				if (!pane.odinTaskTitle && !titleByPane[pane.id]) continue;
				if (!alivePaneIds.has(pane.id)) continue;
				// A read is already in flight for this pane — don't stack them.
				if (readingRef.current.has(pane.id)) continue;
				const tab = tabs.find((item) => item.id === pane.tabId);
				if (!tab) continue;
				readingRef.current.add(pane.id);
				// Reading a screen must not resize the session. createOrAttach hands
				// the host a viewport, and a host old enough to fill in a missing one
				// resizes the live PTY to 80x24 — Claude repaints its TUI at 80
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
						// with no conversation in it. Two reads have to agree —
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
						// `pane` was captured before the await — read the status the
						// hooks hold now, not the one they held when the scan started.
						const read = odinScreenStatus(screen);
						const current = useTabsStore.getState().panes[pane.id]?.status;
						// The one read worth doubting. A dialog and a spinner are
						// things Claude drew; "sitting at the prompt" is the absence
						// of both, which is also what a snapshot caught mid-repaint
						// looks like — and taking it at face value is what yanked a
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
						// leave it be — the next scan or agent event will correct it
					} finally {
						readingRef.current.delete(pane.id);
					}
					// NOTE: do NOT detach here. The whole app shares one socket to the
					// daemon, so detach({paneId}) tears down the stream for the drawer's
					// live terminal too — which was making it render blank.
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
	// One filter at a time, from the header dropdown: "tag:<tag>",
	// "person:<name>", or "" for everything.
	const [boardFilter, setBoardFilter] = useState("");
	// Highlight the Idle column while a card is dragged over it.
	const [dragOverIdle, setDragOverIdle] = useState(false);

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
	 * rather than the drawer's snapshot — the drawer holds the card it was
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
	const openShell = (card: BoardCard) => {
		if (!shellPaneOf(card)) {
			const { paneId } = useTabsStore
				.getState()
				.addTab(card.workspaceId, { initialCwd: sessionCwd(card.pane) });
			// No odinTaskTitle: a shell you opened isn't a task, so it gets no card
			// of its own on the board — same rule the session list uses.
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
	useEffect(() => {
		import.meta.hot?.send("odin:session-pane", drawerOpen);
		return () => import.meta.hot?.send("odin:session-pane", false);
	}, [drawerOpen]);
	/** The shell the drawer is currently showing, if any. */
	const drawerShell = drawerCard ? shellPaneOf(drawerCard) : undefined;
	/**
	 * This session's shell is already running. A shell that exists but whose PTY
	 * died reads as no shell here — you'd be restarting it, not walking into one
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
	const toggleTag = (paneId: string, tag: string) => {
		// Off-list tags from the older, longer vocabulary are dropped here:
		// touch a card's tags and it comes back clean.
		const current = boardTags(panes[paneId]?.odinTags);
		setPaneTags(
			paneId,
			current.includes(tag)
				? current.filter((t) => t !== tag)
				: [...current, tag],
		);
	};

	const { cardsByStatus, completedCards, allTags, allPeople } = useMemo(() => {
		const map = new Map<PaneStatus, BoardCard[]>();
		const completed: BoardCard[] = [];
		// Counted over the sessions the board actually shows — counting every
		// pane made the pill promise cards that were killed or aren't tasks.
		const tagCounts = new Map<string, number>();
		const personCounts = new Map<string, number>();
		for (const column of COLUMNS) map.set(column.status, []);
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
				// Another profile's work — not this board's. Until the profile is
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
				const column = boardColumn(
					status,
					// `undefined` = the poll hasn't answered yet, which is not "dead".
					daemonSessions === undefined ? undefined : alive,
					pane.odinParked ?? false,
					loopingPaneIds.has(pane.id),
				);
				for (const tag of boardTags(pane.odinTags))
					tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
				const person = pane.odinContact ?? contactByPane[pane.id] ?? null;
				if (person)
					personCounts.set(person, (personCounts.get(person) ?? 0) + 1);
				if (
					(boardFilter.startsWith("person:") &&
						person !== boardFilter.slice(7)) ||
					(boardFilter.startsWith("tag:") &&
						!boardTags(pane.odinTags).includes(boardFilter.slice(4)))
				)
					continue;
				// Every session stays on the board in its column until it's Done'd —
				// nothing is silently dropped.
				map.get(column)?.push({ ...card, status: column });
			}
		}
		return {
			cardsByStatus: map,
			completedCards: completed,
			allTags: [...tagCounts.entries()].sort((a, b) =>
				a[0].localeCompare(b[0]),
			),
			allPeople: [...personCounts.entries()].sort((a, b) =>
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
		daemonSessions,
		boardFilter,
		contactByPane,
		titleByPane,
		activeProfileId,
		isProfileLoading,
	]);

	// Write the session briefs in the background, so opening a card shows one
	// straight away rather than starting a 15s model call while you wait. The
	// main process queues them one at a time and skips anything still cached, so
	// re-firing this is cheap.
	const warmBriefs =
		electronTrpc.terminal.warmClaudeSessionBriefs.useMutation();
	const { data: autoRename } =
		electronTrpc.settings.getOdinAutoRenameSessions.useQuery();
	const briefSessionIds = useMemo(
		() =>
			[...cardsByStatus.values()]
				.flat()
				.map(
					(card) =>
						card.pane.claudeSessionId ??
						usePaneMeta.getState().sessionIdByPane[card.pane.id],
				)
				.filter((id): id is string => !!id)
				.sort()
				.join(","),
		[cardsByStatus],
	);
	useEffect(() => {
		if (!briefSessionIds) return;
		const sessionIds = briefSessionIds.split(",");
		const warm = () =>
			warmBriefs.mutate(
				{ sessionIds },
				{
					onSuccess: (r) => {
						applyAutoTags(r.tags);
						if (autoRename) applyAutoTitles(r.titles);
					},
				},
			);
		warm();
		// Live sessions keep working; re-warm so a brief you open later is recent.
		const timer = setInterval(warm, 5 * 60_000);
		return () => clearInterval(timer);
		// warmBriefs is a new object each render — the id list is the real trigger.
	}, [briefSessionIds, autoRename]);

	// A session just launched from the Tasks view → open its drawer here.
	const pendingPaneId = usePendingFocus((s) => s.paneId);
	const clearPendingFocus = usePendingFocus((s) => s.clear);
	useEffect(() => {
		if (!pendingPaneId) return;
		const card = [...cardsByStatus.values()]
			.flat()
			.concat(completedCards)
			.find((c) => c.pane.id === pendingPaneId);
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
	 * attach — typeable.
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
		setDrawerWidth(maxDrawerWidth());
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
			// drawer is open, not just when it opens — it can only take the
			// keyboard when nothing else has it.
			if (!canClaimKeyboard()) return;
			document
				.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
				?.focus();
		};
		const t = setTimeout(focus, 300);
		return () => clearTimeout(t);
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
	 * Wait until Claude's TUI is actually on screen in a freshly respawned pane.
	 * `claude --resume` takes a second or two to boot, and a write that lands
	 * before it is reading is swallowed — the empty-session bug, again.
	 *
	 * ponytail: polls the same screen read the scan below uses, no new plumbing.
	 * Ceiling: gives up after ~15s and says so, rather than typing into the void.
	 */
	const waitForAgent = async (
		paneId: string,
		tabId: string,
		workspaceId: string,
	): Promise<boolean> => {
		// Same rule as the scan: send the mounted xterm's size, or a host that
		// fills in a missing viewport resizes the live PTY to 80x24.
		const mounted = terminalCache.get(paneId)?.xterm;
		for (let attempt = 0; attempt < 15; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			try {
				const result = (await utils.client.terminal.createOrAttach.mutate({
					paneId,
					tabId,
					workspaceId,
					skipColdRestore: true,
					...(mounted && { cols: mounted.cols, rows: mounted.rows }),
				})) as { snapshot?: { snapshotAnsi?: string }; scrollback?: string };
				const screen = (
					result?.snapshot?.snapshotAnsi ??
					result?.scrollback ??
					""
				)
					.replace(ANSI_RE, "")
					.slice(-2500);
				if (agentOnScreen(screen)) return true;
			} catch {
				// pane not up yet — try again
			}
		}
		return false;
	};

	/**
	 * Pick a session back up. On a live PTY that's literally writing "Continue"
	 * into the open prompt — nothing to reopen.
	 *
	 * On a dead one: reopen the conversation (`claude --resume <id>`) in its worktree,
	 * with no opening prompt — the agent comes back idle, not working. Always
	 * respawns the pane running the command as its process — typing into a
	 * cold-restored shell races its startup (p10k/omz) and gets SIGINT'd, so
	 * we kill any existing session first, then createOrAttach with the command
	 * (no shell-typing race, works whether the prior claude is alive or dead).
	 */
	const resumeCard = async (card: BoardCard) => {
		if (resumingPaneIds.includes(card.pane.id)) return;
		// Never started: there's no conversation to resume, only the launch that
		// was held back. Run it now — that's what "Start now" meant on the toast
		// this queue replaced.
		if (card.pane.odinQueued) {
			setResumingPaneIds((ids) => [...ids, card.pane.id]);
			try {
				await startQueuedPane(utils.client, card.pane);
				void utils.terminal.listDaemonSessions.invalidate();
			} catch (error) {
				toast.error(error instanceof Error ? error.message : String(error));
			} finally {
				setResumingPaneIds((ids) => ids.filter((id) => id !== card.pane.id));
			}
			return;
		}
		// Resume kills the PTY first, so on a session that's mid-turn it's an
		// interrupt wearing a Resume label — it throws away the running turn.
		// Live pane + live status (not the drawer's stale snapshot card).
		if (isWorkingNow(card.pane.id)) {
			toast.error("Session is still working — nothing to resume");
			return;
		}
		// Live PTY: the button says Continue, so it just says Continue — the
		// conversation is already open, killing it to reopen it would only cost
		// the scrollback. Unless the terminal on screen right now is a bare shell:
		// you just Ctrl+C'd out of Claude, the scan hasn't caught up, and
		// "Continue" typed at zsh is a command-not-found, not a resume.
		const screen = visibleScreen(card.pane.id);
		const shellOnScreen = screen.trim() !== "" && !agentOnScreen(screen);
		if (agentPaneIds.has(card.pane.id) && !shellOnScreen) {
			try {
				await sendContinue(card.pane.id);
			} catch (error) {
				toast.error(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		// What it was doing when it died. A session killed mid-turn (app quit,
		// daemon restart, machine asleep) keeps "working" on its pane — nothing
		// clears it, which is what makes it readable now. Reopening that one at
		// an idle prompt asks you to retype the obvious; reopening a session
		// that had already stopped doesn't.
		const diedWorking =
			useTabsStore.getState().panes[card.pane.id]?.status === "working";
		// initialCwd included: a session whose terminal was never opened has no
		// confirmed cwd, and resuming without one lands in the wrong repo. The
		// workspace checkout is the last resort — `claude --resume` only finds a
		// conversation from the directory it ran in, so resuming from the
		// daemon's default cwd fails exactly like resuming a missing id.
		const cwd = sessionCwd(card.pane) ?? card.repoPath;
		// Resume THIS conversation, not "whatever ran last here" (what --continue
		// does — wrong as soon as two sessions share a workspace). Session id
		// comes from launch (--session-id); for older sessions, look it up in
		// Claude's transcripts by the task title.
		let sessionId =
			card.pane.claudeSessionId ??
			usePaneMeta.getState().sessionIdByPane[card.pane.id];
		// A pinned --session-id is not proof Claude ever wrote that conversation:
		// this pane ran a full turn (its hooks fired) and left no transcript, so
		// Resume ran `claude --resume <id>`, got "No conversation found with
		// session ID" and exited 1 — a dead pane whose whole history was that
		// line. Ask before touching the PTY, and when it's gone stop here: the
		// answer is a new session, which is the drawer's question to ask, not
		// something to do behind your back. Nothing is substituted either — the
		// title search below matches the newest transcript merely *mentioning*
		// the card title (on this board, an unrelated session), and --continue
		// takes whatever ran last in the repo.
		//
		// Read rather than stat: this call already answers "is this conversation
		// on disk" by id alone, and reusing it keeps the whole check in the
		// renderer. A new main-process procedure sits dormant until the app
		// restarts, which is a fix that silently isn't running.
		if (sessionId) {
			try {
				await utils.client.terminal.readClaudeTranscript.query({ sessionId });
			} catch (error) {
				// Only "Claude has no such conversation" is lost. An unreadable or
				// half-written transcript still belongs to this card — resume it.
				if (String(error).includes("No transcript on this machine")) {
					setLostCard(card);
					return;
				}
			}
		}
		setResumingPaneIds((ids) => [...ids, card.pane.id]);
		// The respawn puts Claude back in this PTY — don't make the next scan
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
		// the whole reason you came back to the session.
		const resumeCmd = sessionId
			? `claude --dangerously-skip-permissions --resume ${sessionId}`
			: "claude --dangerously-skip-permissions --continue";
		try {
			// Free the pane (dead or a live cold-restored shell) so the respawn
			// re-runs the command. Ignore errors — pane may already be dead.
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
						// Alive but not working — nothing was asked of it. A session
						// that died mid-turn is put back to work below and takes
						// "working" back then, once the agent is actually up.
						status: "idle",
						odinParked: false,
						interrupted: false,
						completed: false,
					},
				},
			}));
			setDrawerCard(null);
			// It was mid-turn when it died, so reopening the conversation isn't
			// picking it back up — the agent sits there with the job half done
			// waiting to be told the obvious. Tell it.
			if (diedWorking) {
				void (async () => {
					if (!(await waitForAgent(card.pane.id, card.tabId, card.workspaceId)))
						return;
					try {
						await sendContinue(card.pane.id);
						setPaneStatusFromStore(card.pane.id, "working");
					} catch {
						// the conversation is open either way — type it yourself
					}
				})();
			}
			// ponytail: no toast on the happy path — the card renders its own
			// "resuming…" spinner, and a toast over the board hides other cards.
			// Only the ambiguous --continue fallback is worth interrupting for.
			if (!sessionId) {
				toast.info(
					"Resuming latest session in this repo (no session id found)",
				);
			}
			// Don't sit on the stale poll for up to 5s — ask now so the card leaves
			// Idle as soon as the PTY exists.
			void utils.terminal.listDaemonSessions.invalidate();
			// ponytail: fixed timeout, not a retry loop — if the respawned claude
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
	 * for itself — Claude's transcript is what went missing — so it is exactly
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
	 * The dead card is left alone — its scrollback is the only record of what
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
		toast.success(`Started over on "${title}"`);
	};

	const terminalWrite = electronTrpc.terminal.write.useMutation();
	const terminalKill = electronTrpc.terminal.kill.useMutation();
	/**
	 * Park a card by dragging it to Idle. Idle is the only drop target: the other
	 * columns describe what the agent is actually doing, and dragging a card
	 * can't make that true. A running turn is interrupted first (Esc) — a card
	 * sitting in Idle while its agent works would be a lie.
	 */
	const parkCard = async (card: BoardCard) => {
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
		toast.success("Parked in Idle — session still open");
	};

	/**
	 * Done = end it and off the board. removePane kills the PTY and drops the
	 * pane (and its tab, when it's the only one). There used to be a separate
	 * Kill button; it did the same thing minus the cleanup — the card left the
	 * board either way and the orphaned pane/tab stayed behind forever. Session
	 * History resumes finished sessions from Claude's transcripts on disk, so
	 * keeping the dead pane bought nothing. To stop an agent without ending the
	 * session, drag the card to Idle (Park) instead.
	 */
	const markDone = (card: BoardCard) => {
		useTabsStore.getState().removePane(card.pane.id);
		usePaneMeta.getState().forgetPane(card.pane.id);
		useReminders.getState().clear(`session:${card.pane.id}`);
		setDrawerCard(null);
		toast.success("Done — removed from board");
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
					className="rounded-lg bg-[#14301f] px-2.5 py-1 text-[12px] font-semibold text-[#3ecf8e] transition-colors hover:bg-[#1a4029]"
				>
					+ New Session
				</button>
				{isLaunching && (
					<span className="text-xs text-[#a5a5b3]">starting…</span>
				)}

				{/* filter — right-click a card to tag it; people are the card's contact */}
				{(allTags.length > 0 || allPeople.length > 0) && (
					<select
						value={boardFilter}
						onChange={(e) => setBoardFilter(e.target.value)}
						title="Show only sessions with this tag or person"
						className={cn(
							"max-w-[220px] cursor-pointer rounded-full border px-2.5 py-1 text-[12px] font-medium outline-none",
							boardFilter
								? "border-[#a394ff] bg-[#211d3a] text-[#f5f5f7]"
								: "border-[#25252e] bg-[#16161b] text-[#a5a5b3] hover:text-[#f5f5f7]",
						)}
					>
						<option value="">All sessions</option>
						{allTags.length > 0 && (
							<optgroup label="Tags">
								{allTags.map(([tag, count]) => (
									<option key={tag} value={`tag:${tag}`}>
										#{tag} ({count})
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
			</div>

			{tagMenu && (
				<TagMenu
					x={tagMenu.x}
					y={tagMenu.y}
					tags={boardTags(panes[tagMenu.paneId]?.odinTags)}
					allTags={BOARD_TAGS}
					starred={!!panes[tagMenu.paneId]?.odinStarred}
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
					const sections = bySection(cards);
					// One section is just the column — don't label it, unless it's
					// Parked: "you put these down" is worth saying on its own.
					const labelled =
						sections.length > 1 ||
						sections[0]?.[0] === "parked" ||
						sections[0]?.[0] === "queued";
					const isDropTarget = column.status === "idle";
					return (
						// biome-ignore lint/a11y/noStaticElementInteractions: drop zone — drag is the mouse-only shortcut for parking a card in Idle
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
								"flex min-w-[240px] flex-1 flex-col rounded-xl border bg-[#111114]",
								isDropTarget && dragOverIdle
									? "border-[#a394ff] bg-[#15131f]"
									: "border-[#25252e]",
							)}
						>
							<div className="flex items-center gap-2 px-3 py-2.5 text-xs font-semibold uppercase tracking-[.4px] text-[#a5a5b3]">
								<span
									className="size-2 rounded-full"
									style={{ background: PANE_STATUS[column.status].dot }}
								/>
								{column.label}
								<span className="ml-auto rounded-[10px] bg-[#1f1f27] px-2 font-medium">
									{cards.length}
								</span>
							</div>
							<div className="flex flex-col gap-2 overflow-y-auto px-2 pb-2.5">
								{cards.length === 0 ? (
									<div className="px-2 py-6 text-center text-xs text-[#8a8a97]">
										Nothing here
									</div>
								) : (
									sections.map(([section, group]) => {
										const Icon = SECTION_ICON[section];
										return (
											<Fragment key={section}>
												{labelled && (
													<div className="flex items-center gap-1.5 px-1 pt-1 text-[10px] font-semibold uppercase tracking-[.5px] text-[#8a8a97]">
														<Icon className="size-3" aria-hidden />
														{SECTION_LABEL[section]}
														<span className="opacity-70">{group.length}</span>
														<span className="ml-1 h-px flex-1 bg-[#25252e]" />
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
																	"group cursor-pointer rounded-[10px] border px-3 py-2.5 text-left transition-colors hover:border-[#34343f]",
																	// Every card wears its column's colour. A failure lives
																	// in Needs you now, so it keeps its own red edge rather
																	// than the column's amber.
																	PANE_STATUS[
																		card.pane.status === "failed"
																			? "failed"
																			: card.status
																	].tint,
																)}
															>
																<div className="flex items-start gap-2">
																	<div className="min-w-0 flex-1 break-words text-[12.5px] font-semibold">
																		{card.pane.odinStarred && (
																			<span
																				title="Starred"
																				className="mr-1 text-[#f5c542]"
																			>
																				★
																			</span>
																		)}
																		{cardTitle(card)}
																	</div>
																	<button
																		type="button"
																		title="Done — remove from the board"
																		onClick={(event) => {
																			event.stopPropagation();
																			markDone(card);
																		}}
																		className="shrink-0 rounded-[5px] px-1.5 text-[11px] text-[#8a8a97] opacity-0 transition-opacity hover:bg-[#14301f] hover:text-[#3ecf8e] group-hover:opacity-100"
																	>
																		✓ done
																	</button>
																</div>
																<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
																	{cardContact(card) && (
																		<PersonChip
																			name={cardContact(card) as string}
																		/>
																	)}
																	{boardTags(card.pane.odinTags).map((tag) => (
																		<span
																			key={tag}
																			title={
																				tag === "automation"
																					? "Started by a schedule, not by you"
																					: undefined
																			}
																			className={cn(
																				"inline-flex items-center gap-1 rounded-[5px] px-[7px] text-[11px] font-medium",
																				// Amber and a clock, the pair the Tasks list already
																				// gives a scheduled row. It is the one tag that answers
																				// "who started this?", on a board where every other card
																				// was started by you — in the shared violet it read as
																				// one more subject label, next to #bug and #infra.
																				tag === "automation"
																					? "bg-[#2e2413] text-[#f5b83d]"
																					: "bg-[#211d3a] text-[#a394ff]",
																			)}
																		>
																			{tag === "automation" && (
																				<LuClock className="size-3" />
																			)}
																			#{tag}
																		</span>
																	))}
																	<PrPill
																		card={card}
																		live={card.status === "working"}
																	/>
																	<NotionPill
																		card={card}
																		live={card.status === "working"}
																	/>
																	{/* Which repo this ran in — every card has one,
																	    and "same task, wrong repo" is the thing you
																	    catch by scanning the board. */}
																	<RepoPill card={card} />
																	<AgePill
																		card={card}
																		live={card.status === "working"}
																		fallback={
																			statusSinceRef.current.get(card.pane.id)
																				?.at
																		}
																	/>
																	{agentPaneIds.has(card.pane.id) && (
																		<LoopPill card={card} />
																	)}
																	<LoadPill card={card} />
																	{/* Last, and blank until you set one: a
																	    deadline is yours, not something the
																	    session reports about itself. */}
																	<DueChip
																		itemKey={`session:${card.pane.id}`}
																		title={cardTitle(card)}
																	/>
																</div>
																{card.status === "working" && (
																	<div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-[#a5a5b3]">
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
																{/* ponytail: the "Needs you"/"Done" headers already say
															    the rest — only a failure adds anything. pane.status is
															    the raw one; the column merges prompts and failures. */}
																{card.status === "permission" &&
																	card.pane.status === "failed" && (
																		<div className="mt-1.5 text-xs text-[#f0647a]">
																			✗ failed — click to see what broke
																		</div>
																	)}
																{card.status === "idle" &&
																	!agentPaneIds.has(card.pane.id) &&
																	resumingPaneIds.includes(card.pane.id) && (
																		<div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-[#3ecf8e]">
																			<span className="size-[9px] animate-spin rounded-full border border-[#3ecf8e] border-t-transparent" />
																			{card.pane.odinQueued
																				? "starting…"
																				: "resuming…"}
																		</div>
																	)}
																{/* Never started — it's waiting on the machine, not
																    on you. Says what for, and lets you overrule it. */}
																{card.pane.odinQueued &&
																	!resumingPaneIds.includes(card.pane.id) && (
																		<div className="mt-1.5 flex items-center gap-2">
																			<span className="text-[11.5px] text-[#f5b83d]">
																				⏳ {card.pane.odinQueued.reason}
																			</span>
																			<button
																				type="button"
																				title="Start this session now, gate or no gate"
																				onClick={(event) => {
																					event.stopPropagation();
																					void resumeCard(card);
																				}}
																				className="ml-auto rounded-[7px] bg-[#1f1f27] px-2.5 py-1 text-xs font-semibold text-[#a5a5b3] hover:text-[#3ecf8e]"
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
																			{/* ponytail: the button says "resume" — only a
																		    failure is worth spelling out. */}
																			{card.pane.status === "failed" && (
																				<span className="text-[11.5px] text-[#f0647a]">
																					✗ failed
																				</span>
																			)}
																			{/* Resume does more here than on the other
																		    cards — it puts the agent back to work
																		    instead of handing you a prompt. */}
																			{card.pane.status === "working" && (
																				<span className="text-[11.5px] text-[#f5b83d]">
																					⏸ died mid-turn
																				</span>
																			)}
																			<button
																				type="button"
																				onClick={(event) => {
																					event.stopPropagation();
																					void resumeCard(card);
																				}}
																				className="rounded-[7px] bg-[#14301f] px-2.5 py-1 text-xs font-semibold text-[#3ecf8e] hover:bg-[#1a3d28]"
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
															className="max-h-[70vh] w-[400px] overflow-y-auto border-[#4a4a5c] bg-[#1d1d24] p-3 shadow-[0_12px_40px_rgba(0,0,0,0.75)]"
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
			</div>

			{/* No Completed strip and no link to one: the Session History pane in the
			    sidebar already searches and resumes finished sessions. */}

			{/* session drawer */}
			{drawerCard && (
				<>
					<button
						type="button"
						aria-label="Close drawer"
						className="fixed inset-0 z-40 cursor-default bg-black/35"
						onClick={() => setDrawerCard(null)}
					/>
					{/* absolute, not fixed: it fills the content area, which starts below
					    the top bar. A top-0 fixed drawer put its title under the macOS
					    traffic lights, and the native buttons eat the click. */}
					<div
						className="absolute right-0 top-0 z-50 flex h-full max-w-full flex-col border-l border-[#25252e] bg-[#111114]"
						style={{ width: drawerWidth }}
					>
						{/* drag handle — resize the drawer from its left edge */}
						<div
							onPointerDown={startDrawerResize}
							className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-[#a394ff]/40"
						/>
						{/* Minimize, on the edge the pointer is already on — the Close
						    button is a whole drawer away. The session keeps running. */}
						<button
							type="button"
							aria-label="Minimize"
							title="Minimize — back to the board (the session keeps running)"
							onClick={() => setDrawerCard(null)}
							className="absolute left-0 top-1/2 z-20 -translate-y-1/2 rounded-r-[7px] border border-l-0 border-[#25252e] bg-[#1f1f27] py-2.5 pl-[3px] pr-1 text-[11px] leading-none text-[#a5a5b3] hover:bg-[#25252e] hover:text-[#f5f5f7]"
						>
							›
						</button>
						<div className="border-b border-[#25252e] px-4 py-3.5">
							<div className="flex items-center gap-2">
								{renameDraft === null ? (
									<button
										type="button"
										title="Click to rename this session"
										onClick={() => setRenameDraft(cardTitle(drawerCard))}
										className="min-w-0 flex-1 truncate text-left text-sm font-semibold hover:text-[#a394ff]"
									>
										{cardTitle(drawerCard)}
									</button>
								) : (
									<input
										// Focus on mount without the autoFocus attribute the a11y
										// lint flags — same trick as TagMenu's input.
										ref={(element) => element?.focus()}
										value={renameDraft}
										onChange={(event) => setRenameDraft(event.target.value)}
										onBlur={() => renamePane(drawerCard.pane.id, renameDraft)}
										onKeyDown={(event) => {
											if (event.key === "Enter")
												renamePane(drawerCard.pane.id, renameDraft);
										}}
										className="min-w-0 flex-1 rounded-md border border-[#a394ff] bg-[#0a0a0c] px-2 py-1 text-sm font-semibold text-[#f5f5f7] outline-none"
									/>
								)}
								{drawerCard.pane.type === "terminal" && (
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
												? "bg-[#211d3a] text-[#a394ff]"
												: "bg-[#1f1f27] text-[#a5a5b3] hover:text-[#f5f5f7]",
										)}
									>
										⑂ Diff
									</button>
								)}
								{drawerCard.pane.type === "terminal" && (
									<button
										type="button"
										title={
											shellRunning
												? "This session already has a shell running — reattach to it"
												: "Open a shell in this session's checkout"
										}
										onClick={() =>
											isShellOpen
												? setIsShellOpen(false)
												: openShell(drawerCard)
										}
										className={cn(
											"shrink-0 rounded-md px-2 py-1 text-xs font-semibold",
											isShellOpen
												? "bg-[#211d3a] text-[#a394ff]"
												: "bg-[#1f1f27] text-[#a5a5b3] hover:text-[#f5f5f7]",
										)}
									>
										❯ Shell
										{shellRunning && (
											<span className="ml-1 inline-block size-[6px] rounded-full bg-[#3ecf8e] align-middle" />
										)}
									</button>
								)}
								<button
									type="button"
									title="Toggle the session brief"
									onClick={() => setIsBriefOpen((open) => !open)}
									className={cn(
										"shrink-0 rounded-md px-2 py-1 text-xs font-semibold",
										isBriefOpen
											? "bg-[#211d3a] text-[#a394ff]"
											: "bg-[#1f1f27] text-[#a5a5b3] hover:text-[#f5f5f7]",
									)}
								>
									ⓘ Brief
								</button>
								<button
									type="button"
									title="Toggle full width"
									onClick={() =>
										setDrawerWidth((width) =>
											width < maxDrawerWidth()
												? maxDrawerWidth()
												: Math.round(window.innerWidth * 0.6),
										)
									}
									className="shrink-0 rounded-md bg-[#1f1f27] px-2 py-1 text-xs font-semibold text-[#a5a5b3] hover:text-[#f5f5f7]"
								>
									⛶
								</button>
							</div>
							<div className="mt-1.5 flex flex-wrap gap-1.5">
								{cardContact(drawerCard) && (
									<PersonChip name={cardContact(drawerCard) as string} />
								)}
								{drawerLink && (
									<button
										type="button"
										title={drawerLink.url}
										onClick={() => openUrl.mutate(drawerLink.url)}
										className="rounded-[5px] bg-[#211d3a] px-[7px] text-[11px] font-medium text-[#a394ff] hover:underline"
									>
										{drawerLink.label} ↗
									</button>
								)}
								{sessionCwd(drawerCard.pane) && (
									<span
										title={sessionCwd(drawerCard.pane)}
										className="rounded-[5px] bg-[#1f1f27] px-[7px] text-[11px] text-[#a394ff]"
									>
										{sessionCwd(drawerCard.pane)?.split("/").slice(-1)[0]}
									</span>
								)}
								<span className="rounded-[5px] bg-[#1f1f27] px-[7px] text-[11px] text-[#a5a5b3]">
									{drawerCard.status}
								</span>
							</div>
						</div>
						{/* terminal on the left, "what's going on" brief on the right */}
						<div className="flex min-h-0 flex-1">
							<div className="flex min-h-0 min-w-0 flex-1 flex-col">
								{isShellOpen && drawerShell ? (
									// A shell in the same checkout, mounted like any other pane —
									// it spawns on first mount with the session's cwd.
									<div className="min-h-0 flex-1 bg-[#0a0a0c] p-2">
										<Terminal
											key={drawerShell.id}
											paneId={drawerShell.id}
											tabId={drawerShell.tabId}
											workspaceId={drawerCard.workspaceId}
										/>
									</div>
								) : isDiffOpen && drawerCard.pane.type === "terminal" ? (
									<DiffView
										key={drawerCard.pane.id}
										cwd={sessionCwd(drawerCard.pane) ?? null}
										claudeSessionId={drawerCard.pane.claudeSessionId ?? null}
										workspaceId={drawerCard.workspaceId}
									/>
								) : drawerCard.pane.type !== "terminal" ? (
									<div className="flex-1 select-text cursor-text overflow-y-auto px-4 py-3 text-[12.5px] text-[#a5a5b3]">
										{drawerCard.pane.cwd && (
											<div>cwd: {drawerCard.pane.cwd}</div>
										)}
										<div className="mt-2">
											Chat session — no terminal to embed.
										</div>
									</div>
								) : alivePaneIds.has(drawerCard.pane.id) ? (
									// Live pane — the real PTY, attached read/write. xterm is the
									// only thing that renders Claude Code's full-screen TUI legibly
									// (scrollback replay is a stream of overlapping frames = mush).
									<div className="min-h-0 flex-1 bg-[#0a0a0c] p-2">
										<Terminal
											key={drawerCard.pane.id}
											paneId={drawerCard.pane.id}
											tabId={drawerCard.tabId}
											workspaceId={drawerCard.workspaceId}
										/>
									</div>
								) : (
									// Dead pane — no live PTY to attach; show the persisted
									// transcript read-only (best-effort for a TUI).
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
								/>
							)}
						</div>
						<div className="flex gap-2 border-t border-[#25252e] px-4 py-3">
							{drawerCard.pane.type === "terminal" && (
								<button
									type="button"
									disabled={
										resumingPaneIds.includes(drawerCard.pane.id) ||
										isWorkingNow(drawerCard.pane.id)
									}
									onClick={() => void resumeCard(drawerCard)}
									title={
										isWorkingNow(drawerCard.pane.id)
											? "Already working — resuming would kill the running turn"
											: agentPaneIds.has(drawerCard.pane.id)
												? 'Session is open — send it "Continue"'
												: drawerCard.pane.status === "working"
													? 'Died mid-turn — reopen it and send "Continue"'
													: "Reopen this conversation at an idle prompt (claude --resume)"
									}
									className="rounded-[7px] bg-[#14301f] px-3 py-1.5 text-xs font-semibold text-[#3ecf8e] hover:bg-[#1a3d28] disabled:opacity-60 disabled:hover:bg-[#14301f]"
								>
									{drawerCard.pane.odinQueued
										? resumingPaneIds.includes(drawerCard.pane.id)
											? "▶ Starting…"
											: "▶ Start now"
										: resumingPaneIds.includes(drawerCard.pane.id)
											? "↻ Resuming…"
											: isWorkingNow(drawerCard.pane.id)
												? "↻ Working…"
												: // Resume already landed and Claude is up — the button
													// writes "Continue" into the open prompt. A live PTY with
													// no Claude in it (Ctrl+C'd out) still says Resume.
													agentPaneIds.has(drawerCard.pane.id)
													? "↻ Continue"
													: "↻ Resume"}
								</button>
							)}
							<button
								type="button"
								onClick={() => markDone(drawerCard)}
								title="Done — end the session and remove it from the board"
								className="rounded-[7px] bg-[#1f1f27] px-3 py-1.5 text-xs font-semibold text-[#a5a5b3] hover:text-[#3ecf8e]"
							>
								✓ Done
							</button>
							<button
								type="button"
								onClick={() => setDrawerCard(null)}
								className="ml-auto rounded-[7px] bg-[#1f1f27] px-3 py-1.5 text-xs font-semibold text-[#a5a5b3]"
							>
								Close
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
					onCancel={() => setIsComposerOpen(false)}
					onSubmit={handleNewSession}
				/>
			)}
		</div>
	);
}
