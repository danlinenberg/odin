import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "@odin/ui/dropdown-menu";
import { toast } from "@odin/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@odin/ui/tooltip";
import { cn } from "@odin/ui/utils";
import {
	createFileRoute,
	Outlet,
	useMatchRoute,
	useNavigate,
} from "@tanstack/react-router";
import type { ClaudeUsageWindow } from "lib/trpc/routers/resource-metrics";
import { memo, useEffect, useMemo, useState } from "react";
import {
	HiOutlineBolt,
	HiOutlineChartBar,
	HiOutlineClipboardDocumentCheck,
	HiOutlineClock,
	HiOutlineCog6Tooth,
	HiOutlineEllipsisVertical,
	HiOutlineMoon,
	HiOutlineScale,
	HiOutlineViewColumns,
} from "react-icons/hi2";
import { ClaudeCommandPicker } from "renderer/components/ClaudeCommandPicker";
import { ZoomStable } from "renderer/components/ZoomStable/ZoomStable";
import { QUEUE_POLL, useTaskQueue } from "renderer/hooks/useTaskQueue";
import { useZoomFactor } from "renderer/hooks/useZoomFactor";
import { parseBinding, useBinding, useHotkey } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useLaunchLimits } from "renderer/stores/launch-limits";
import { useTabsStore } from "renderer/stores/tabs/store";
import {
	type LaunchLimits,
	type MachineLoad,
	machineLoad,
} from "shared/machine-load";
import { useApplyDropRules } from "./all/drop-rules";
import { ClaudeSignInBanner } from "./components/ClaudeSignInBanner";
import { CrowButton } from "./components/CrowButton";
import { FEED_TABS } from "./components/feed-counts";
import { GettingStarted } from "./components/GettingStarted";
import { InAppBrowser } from "./components/InAppBrowser";
import { BUTTON, PILL } from "./components/pill";
import {
	type UpstreamDue,
	useDueReminders,
	useReminders,
} from "./components/Reminders";
import { useReplyWatcher } from "./components/ReplyWatch";
import { SearchAll } from "./components/SearchAll";
import { SessionContextDialog } from "./components/SessionContextDialog";
import { QuickAddTask } from "./components/TaskBox";
import { UpdateBanner } from "./components/UpdateBanner";
import { useAutomationRunner } from "./hooks/useAutomationRunner";
import { usePeriodicSweep } from "./hooks/useBacklogReview";
import {
	profileLabel,
	useBoardCountsByProfile,
} from "./hooks/useBoardCountsByProfile";
import { crowPane, useCrow, useCrowDialog } from "./hooks/useCrow";
import { useNightAgentRunner } from "./hooks/useNightAgentRunner";
import { useOdinFeeds } from "./hooks/useOdinFeeds";
import { useOdinProfile } from "./hooks/useOdinProfile";
import { usePendingFocus } from "./hooks/usePendingFocus";
import { useSlackAutoLaunch } from "./hooks/useStartReaction";

/**
 * Odin's shell - minimal chrome for the Dev Board, My Tasks, Slack, Session
 * History, My Jira and My PRs views:
 * slim icon rail + top bar, drawn from the theme tokens like every other page,
 * matching the agreed mock rather than the stock dashboard.
 */

export const Route = createFileRoute("/_authenticated/_odin")({
	component: OdinShell,
});

/**
 * The rail, in order. Every feed - my own tasks, Slack, Jira, PRs, Notion,
 * is one Tasks entry: they're all things to do, so they live behind a single icon
 * and switch through the strip in the view's header (FeedTabs). The per-feed
 * keys still jump straight to one; each is rebindable in Settings → Keyboard.
 */
const RAIL_ITEMS = [
	{
		to: "/board" as const,
		hotkey: "ODIN_BOARD" as const,
		label: "Dev Board",
		Icon: HiOutlineViewColumns,
	},
	{
		to: "/all" as const,
		hotkey: "ODIN_ALL" as const,
		label: "Tasks",
		Icon: HiOutlineClipboardDocumentCheck,
	},
	// Its own entry, not a feed tab: an automation isn't waiting on you, it runs itself.
	{
		to: "/automations" as const,
		hotkey: "ODIN_AUTOMATIONS" as const,
		label: "Automations",
		Icon: HiOutlineBolt,
	},
	{
		to: "/night-agent" as const,
		label: "Night Agent",
		Icon: HiOutlineMoon,
	},
];

/**
 * Settings is app chrome, not a feed - foot of the rail. The stock entry point
 * lives in the sidebar this fork redirects away from, so without this the
 * settings screen (rail key rebinding included) is unreachable by mouse.
 */
const SETTINGS_ITEM = {
	to: "/settings" as const,
	hotkey: "OPEN_SETTINGS" as const,
	label: "Settings",
	Icon: HiOutlineCog6Tooth,
};

/**
 * The views you visit now and then - one "More" button, always the last of
 * the top group. Each keeps its single-key hotkey.
 */
const MORE_ITEMS = [
	// Its own page rather than a feed tab: the strip answers "what's waiting
	// on me" from a source; this answers "what can go".
	{
		to: "/review" as const,
		hotkey: "ODIN_REVIEW" as const,
		label: "Review",
		Icon: HiOutlineScale,
	},
	{
		to: "/insights" as const,
		hotkey: "ODIN_INSIGHTS" as const,
		label: "Insights",
		Icon: HiOutlineChartBar,
	},
	{
		to: "/sessions" as const,
		hotkey: "ODIN_SESSIONS" as const,
		label: "Session History",
		Icon: HiOutlineClock,
	},
];

/**
 * Single-key nav: bare keys, so they must not fire while you're typing.
 * react-hotkeys-hook skips form tags and contenteditable when told to - which
 * also covers xterm's hidden textarea, i.e. the embedded agent terminals.
 */
const NAV_HOTKEY_OPTIONS = {
	enableOnFormTags: false,
	enableOnContentEditable: false,
} as const;

type StatusTone = "ok" | "attention" | "danger";

/** One line of the status pill: its words on the bar, its sentence on hover. */
type StatusItem = { tone: StatusTone; bar: string; detail: string };

const TONE_PILL: Record<StatusTone, string> = {
	ok: "bg-secondary text-muted-foreground",
	attention: PILL.attention,
	danger: PILL.danger,
};

const TONE_TEXT: Record<StatusTone, string> = {
	ok: "",
	attention: "text-attention-ink",
	danger: "text-danger-ink",
};

/**
 * This Mac's line, walked up as it gets tighter - fine while there's slack,
 * amber when it's filling up (naming what is), red when agents are queueing
 * or the memory is gone.
 */
function loadStatus(
	load: MachineLoad,
	limits: LaunchLimits,
	freeing: boolean,
): StatusItem {
	const detail = `${
		load.busy
			? `${load.reason} - new sessions wait until that clears. ${load.agentCount} session(s) using ${load.agentMemoryGb} GB; this Mac is ${load.cpuPercent}% busy with ${load.availableMemoryGb} GB free.`
			: `This Mac: ${load.agentCount} session(s) using ${load.agentMemoryGb} GB of memory, ${load.availableMemoryGb} GB free. Agents are on ${load.agentCpuPercent}% of the CPU · this Mac is ${load.cpuPercent}% busy.`
	}${
		load.diskFreeGb !== null
			? ` Disk ${load.diskFreeGb} GB free; new sessions wait below ${limits.minFreeDiskGb} GB (Settings → Sessions).`
			: ""
	}`;
	if (freeing) return { tone: "attention", bar: "Freeing disk…", detail };
	if (load.busy)
		return { tone: "danger", bar: `${load.reason} · launches waiting`, detail };
	const tight = [
		load.cpuPercent >= limits.hostCpuPercent - 15 && `CPU ${load.cpuPercent}%`,
		load.availableMemoryGb < limits.minFreeMemoryGb + 1 &&
			`${load.availableMemoryGb} GB free`,
		load.diskFreeGb !== null &&
			load.diskFreeGb < limits.minFreeDiskGb + 20 &&
			`disk ${load.diskFreeGb} GB`,
	].filter(Boolean);
	return tight.length > 0
		? { tone: "attention", bar: tight.join(" · "), detail }
		: { tone: "ok", bar: "", detail };
}

function usageStatus(
	label: string,
	name: string,
	window: ClaudeUsageWindow,
): StatusItem {
	return {
		tone:
			window.percent >= 90
				? "danger"
				: window.percent >= 75
					? "attention"
					: "ok",
		bar: `${label} ${window.percent}%`,
		detail: `${name}: ${window.percent}% used${resetsIn(window.resetsAt)}.`,
	};
}

function resetsIn(resetsAt: string | null): string {
	if (!resetsAt) return "";
	const when = new Date(resetsAt);
	const soon = when.getTime() - Date.now() < 24 * 3_600_000;
	return `, resets ${when.toLocaleString(undefined, soon ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric" })}`;
}

type ClaudeUsage = {
	fiveHour: ClaudeUsageWindow | null;
	week: ClaudeUsageWindow | null;
};

const CLAUDE_USAGE_KEY = "odin:last-claude-usage";

/** The last good usage reading, kept across remounts and reloads. A window
 *  whose reset has passed is dropped - its percent no longer holds. */
function useLastClaudeUsage(
	now: ClaudeUsage | null | undefined,
): ClaudeUsage | null {
	if (now) {
		try {
			localStorage.setItem(CLAUDE_USAGE_KEY, JSON.stringify(now));
		} catch {}
	}
	let last: ClaudeUsage | null = now ?? null;
	if (!last) {
		try {
			last = JSON.parse(localStorage.getItem(CLAUDE_USAGE_KEY) ?? "null");
		} catch {}
	}
	if (!last) return null;
	const live = (w: ClaudeUsageWindow | null) =>
		w && (!w.resetsAt || new Date(w.resetsAt).getTime() > Date.now())
			? w
			: null;
	return { fiveHour: live(last.fiveHour), week: live(last.week) };
}

/**
 * The shell's background work: feed sync, reminders and the runners. Its own
 * component that draws nothing, so each poll and tick re-renders this and
 * not the whole shell, and a shell render doesn't re-run them.
 */
const ShellRunners = memo(function ShellRunners({
	activeProfileId,
	isProfileLoading,
}: {
	activeProfileId: string;
	isProfileLoading: boolean;
}) {
	// Sync every feed (Slack, Jira, PRs, Notion) as soon as the app
	// opens - the
	// shell mounts on boot and on reload - so switching views shows rows
	// instead of an empty "syncing…".
	const { jira } = useOdinFeeds();
	// "Drop tasks like this" rules put new matching rows away as they arrive.
	useApplyDropRules();
	// Due dates ping from the shell, not from the feed that set them: the feed
	// you set it on is the one you're least likely to have open on the day.
	// Jira's own Due Date rides along, so a deadline nobody retyped into Odin
	// still speaks.
	const jiraDue = useMemo(
		(): UpstreamDue[] =>
			(jira.data?.issues ?? [])
				.filter((issue) => !!issue.dueDate)
				.map((issue) => ({
					key: `jira:${issue.key}`,
					due: issue.dueDate as string,
					title: `${issue.key}: ${issue.title}`,
				})),
		[jira.data],
	);
	// Reminders show and ping for the active profile only.
	const setReminderProfile = useReminders((s) => s.setProfile);
	useEffect(() => {
		if (!isProfileLoading) setReminderProfile(activeProfileId);
	}, [isProfileLoading, activeProfileId, setReminderProfile]);
	useDueReminders(jiraDue);
	// "Ping me on replies" - same reason: it pings whatever screen is open.
	// Clicking the banner opens the session it was set on.
	const navigate = useNavigate();
	useReplyWatcher((paneId) => {
		usePendingFocus.getState().focus(paneId);
		navigate({ to: "/board" });
	});

	// The clock behind the Automations panel. Here rather than on that page:
	// a schedule that only runs while you're looking at it isn't one.
	useAutomationRunner();
	useNightAgentRunner();
	// And the backlog sweep, on its interval, so Review is already filled in.
	usePeriodicSweep();
	// Same reason: tasks held back by the capacity gate wait in Idle → Queued,
	// and this is what starts them once the Mac (or the checkout) frees up.
	useTaskQueue();
	// :robot_face: on a Slack message starts its session - see useStartReaction.
	useSlackAutoLaunch();
	return null;
});

function OdinShell() {
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const zoomFactor = useZoomFactor();
	const { data: platform } = electronTrpc.window.getPlatform.useQuery();
	const isFeedRoute = FEED_TABS.some(
		(tab) => !!matchRoute({ to: tab.to, fuzzy: true }),
	);
	// Default to the Mac layout while loading, so the bar never starts out
	// overlapping the traffic lights.
	const isMac = platform === undefined || platform === "darwin";

	// What the agents are costing this Mac - the same reading that decides
	// whether a new session starts now or waits (see useLaunchTaskSession).
	// The one poller of this snapshot: the board's pills and chips read it
	// without their own interval. It keeps polling while Odin is in the
	// background, because the task queue (useTaskQueue) starts on its readings.
	const { data: metrics } = electronTrpc.resourceMetrics.getSnapshot.useQuery(
		undefined,
		QUEUE_POLL,
	);
	const hostCpuPercent = useLaunchLimits((s) => s.hostCpuPercent);
	const minFreeMemoryGb = useLaunchLimits((s) => s.minFreeMemoryGb);
	const minFreeDiskGb = useLaunchLimits((s) => s.minFreeDiskGb);
	const maxWorkingAgents = useLaunchLimits((s) => s.maxWorkingAgents);
	const limits = {
		hostCpuPercent,
		minFreeMemoryGb,
		minFreeDiskGb,
		maxWorkingAgents,
	};
	const load = metrics ? machineLoad(metrics, limits) : null;
	// The hosts sessions run on, one per line: a string, so the store
	// selector stays stable between renders.
	const remoteHostLines = useTabsStore((s) =>
		Object.values(s.panes)
			.flatMap((pane) =>
				pane.odinRemote && !pane.completed ? [pane.odinRemote] : [],
			)
			.join("\n"),
	);
	const remoteHosts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const host of remoteHostLines.split("\n").filter(Boolean))
			counts.set(host, (counts.get(host) ?? 0) + 1);
		return [...counts];
	}, [remoteHostLines]);
	const diskFull = load?.diskFreeGb != null && load.diskFreeGb < minFreeDiskGb;
	// The disk pill offers what the 10-minute pruner would delete anyway (the
	// "safe" rows in Settings → Storage), so a full disk is one click from free.
	const trpcUtils = electronTrpc.useUtils();
	const removeWorktrees = electronTrpc.repos.removeWorktrees.useMutation();
	const [freeing, setFreeing] = useState(false);
	const freeDisk = async () => {
		if (freeing) return;
		setFreeing(true);
		try {
			const safe = (await trpcUtils.repos.worktrees.fetch()).filter(
				(wt) => wt.safe,
			);
			const bytes = safe.reduce((sum, wt) => sum + (wt.sizeBytes ?? 0), 0);
			const size = `${(bytes / 1024 ** 3).toFixed(1)} GB`;
			if (safe.length === 0) {
				toast.info(
					"No unused worktrees to delete - Settings → Storage lists the rest.",
				);
				return;
			}
			if (
				!window.confirm(
					`Delete ${safe.length} unused worktree${safe.length === 1 ? "" : "s"} (${size})? Their work already landed or their PR closed.`,
				)
			)
				return;
			const removed = await removeWorktrees.mutateAsync(
				safe.map(({ repo, name }) => ({ repo, name })),
			);
			toast.success(
				`Deleted ${removed.length} worktree${removed.length === 1 ? "" : "s"}`,
			);
			void trpcUtils.repos.worktrees.invalidate();
		} catch (error) {
			toast.error(`Couldn't delete worktrees: ${String(error)}`);
		} finally {
			setFreeing(false);
		}
	};
	// Claude plan usage - the 5-hour window and the week, as /usage shows them.
	// The endpoint 429s when polled hard (every Claude Code CLI hits it too)
	// and a failed read comes back null - so poll gently and keep showing the
	// last good reading rather than dropping the pill. The reading lives in
	// localStorage, not a ref: a remount, a renderer reload or a profile switch
	// (which resets every query) would otherwise blank it until a poll landed
	// between 429s - with twenty sessions polling too, that's minutes.
	const { data: usageNow } =
		electronTrpc.resourceMetrics.getClaudeUsage.useQuery(undefined, {
			refetchInterval: 5 * 60_000,
		});
	const usage = useLastClaudeUsage(usageNow);

	// The accounts in play. Switching resets every query, so the feeds below
	// refetch against the new profile's Slack/Jira/GitHub rather than showing
	// the old profile's rows under the new name.
	const {
		activeId: activeProfileId,
		isLoading: isProfileLoading,
		profiles,
		switchTo: switchProfile,
		isSwitching: isSwitchingProfile,
	} = useOdinProfile();
	// A session waiting on you - or working - under the *other* profile is
	// invisible until you switch: the board only draws one profile's cards. The
	// picker says so.
	const boardCountsByProfile = useBoardCountsByProfile();
	const otherProfilesBusy = profiles
		.filter((profile) => profile.id !== activeProfileId)
		.map((profile) => ({
			id: profile.id,
			name: profile.name,
			needsYou: 0,
			working: 0,
			...boardCountsByProfile.get(profile.id),
		}))
		.filter((profile) => profile.needsYou > 0 || profile.working > 0);

	const { data: workConfig } = electronTrpc.work.getConfig.useQuery();
	// Single-key nav - D board, T tasks, S slack, H history, J jira, P PRs
	// by default, and whatever
	// Settings → Keyboard shortcuts says after that. The returned display drives
	// each rail tooltip, so the hint can't drift from the binding.
	const railHotkeys = {
		ODIN_BOARD: useHotkey(
			"ODIN_BOARD",
			() => navigate({ to: "/board" }),
			NAV_HOTKEY_OPTIONS,
		),
		ODIN_ALL: useHotkey(
			"ODIN_ALL",
			() => navigate({ to: "/all" }),
			NAV_HOTKEY_OPTIONS,
		),
		ODIN_AUTOMATIONS: useHotkey(
			"ODIN_AUTOMATIONS",
			() => navigate({ to: "/automations" }),
			NAV_HOTKEY_OPTIONS,
		),
		ODIN_REVIEW: useHotkey(
			"ODIN_REVIEW",
			() => navigate({ to: "/review" }),
			NAV_HOTKEY_OPTIONS,
		),
		ODIN_SLACK: useHotkey(
			"ODIN_SLACK",
			() => navigate({ to: "/reactions" }),
			NAV_HOTKEY_OPTIONS,
		),
		ODIN_INSIGHTS: useHotkey(
			"ODIN_INSIGHTS",
			() => navigate({ to: "/insights" }),
			NAV_HOTKEY_OPTIONS,
		),
		ODIN_SESSIONS: useHotkey(
			"ODIN_SESSIONS",
			() => navigate({ to: "/sessions" }),
			NAV_HOTKEY_OPTIONS,
		),
		ODIN_TASKS: useHotkey(
			"ODIN_TASKS",
			() => navigate({ to: "/my-tasks" }),
			NAV_HOTKEY_OPTIONS,
		),
		ODIN_JIRA: useHotkey(
			"ODIN_JIRA",
			() => navigate({ to: "/jira" }),
			NAV_HOTKEY_OPTIONS,
		),
		ODIN_PRS: useHotkey(
			"ODIN_PRS",
			() => navigate({ to: "/prs" }),
			NAV_HOTKEY_OPTIONS,
		),
		ODIN_NOTION: useHotkey(
			"ODIN_NOTION",
			() => navigate({ to: "/notion" }),
			NAV_HOTKEY_OPTIONS,
		),
		// Modifier chord (⌘,), so it stays live inside terminals and inputs -
		// hence the default options rather than NAV_HOTKEY_OPTIONS.
		OPEN_SETTINGS: useHotkey("OPEN_SETTINGS", () =>
			navigate({ to: "/settings" }),
		),
	};

	// Write a task down from wherever you are - a chord too, so it reaches you
	// inside a session's terminal, which is where most of them occur to you.
	const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
	const newTaskKeys = useHotkey("ODIN_NEW_TASK", () => setIsQuickAddOpen(true));
	// The same chord from any other app too: Odin comes forward with the box
	// open, and steps back once you're done with it.
	const [hideOnQuickAddClose, setHideOnQuickAddClose] = useState(false);
	const newTaskBinding = useBinding("ODIN_NEW_TASK");
	const newTaskChord = newTaskBinding
		? parseBinding(newTaskBinding).chord
		: null;
	const setNewTaskChord = electronTrpc.menu.setNewTaskChord.useMutation();
	const hideApp = electronTrpc.menu.hideApp.useMutation();
	// biome-ignore lint/correctness/useExhaustiveDependencies: mutate is stable
	useEffect(() => {
		setNewTaskChord.mutate({ chord: newTaskChord });
	}, [newTaskChord]);
	electronTrpc.menu.subscribe.useSubscription(undefined, {
		onData: (event) => {
			if (event.type !== "new-task") return;
			setHideOnQuickAddClose(event.data.fromElsewhere);
			setIsQuickAddOpen(true);
		},
	});
	const closeQuickAdd = () => {
		setIsQuickAddOpen(false);
		if (hideOnQuickAddClose) hideApp.mutate();
		setHideOnQuickAddClose(false);
	};
	const { ask: askCrow, resume: resumeCrow } = useCrow();
	const isCrowOpen = useCrowDialog((s) => s.isOpen);
	const setCrowOpen = useCrowDialog((s) => s.setOpen);
	const openCrow = useTabsStore((s) => crowPane(s.panes));
	const crowKeys = useHotkey("ODIN_ASK_CROW", () => setCrowOpen(true));
	const [isSearchAllOpen, setIsSearchAllOpen] = useState(false);
	useHotkey("ODIN_SEARCH_ALL", () => setIsSearchAllOpen(true));

	const isMoreActive = MORE_ITEMS.some(
		({ to }) => !!matchRoute({ to, fuzzy: true }),
	);

	const renderRailItem = ({
		to,
		label,
		hotkey,
		Icon,
	}: (typeof RAIL_ITEMS)[number] | typeof SETTINGS_ITEM) => {
		// Tasks stands for every feed: lit on any of them, and always opening on
		// All - every source at once is the answer to "what's waiting on me".
		const isFeeds = to === "/all";
		const isActive = isFeeds ? isFeedRoute : !!matchRoute({ to, fuzzy: true });
		const keys = hotkey ? railHotkeys[hotkey].text : "";
		const hint = keys ? `${label} (${keys})` : label;
		return (
			<Tooltip key={to} delayDuration={300}>
				<TooltipTrigger asChild>
					<button
						type="button"
						aria-label={label}
						aria-current={isActive ? "page" : undefined}
						onClick={() => navigate({ to })}
						className={cn(
							"flex size-9 items-center justify-center rounded-[9px] transition-colors",
							isActive
								? BUTTON.selected
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<Icon className="size-[17px]" />
					</button>
				</TooltipTrigger>
				<TooltipContent side="right">{hint}</TooltipContent>
			</Tooltip>
		);
	};

	return (
		// The faint violet light over the top-left of every page is the shell's
		// - it's what keeps a dark, mostly-neutral app from reading as grey.
		<div className="flex h-full w-full flex-col bg-background bg-[radial-gradient(1200px_420px_at_18%_-160px,color-mix(in_oklab,var(--primary)_13%,transparent),transparent_70%)] text-foreground">
			<ShellRunners
				activeProfileId={activeProfileId}
				isProfileLoading={isProfileLoading}
			/>
			{/* top bar - left pad clears macOS traffic lights; empty areas drag.
			    The traffic lights are native and DON'T scale with page zoom, so the
			    bar height and their inset are counter-scaled by 1/zoomFactor to stay
			    a constant physical size (otherwise zooming out slides the bar under
			    the lights). Same trick the stock TopBar uses. */}
			<div
				className="relative flex shrink-0 items-center gap-3 border-b border-border bg-tertiary/70 pr-3"
				style={isMac ? { height: `${36 / zoomFactor}px` } : undefined}
			>
				<div
					className="h-full shrink-0 [-webkit-app-region:drag]"
					style={{ width: isMac ? `${84 / zoomFactor}px` : "16px" }}
				/>
				<ZoomStable enabled={isMac}>
					<span className="bg-gradient-to-r from-primary-ink to-primary bg-clip-text text-xs font-bold text-transparent">
						{workConfig?.isDev ? "Odin Dev" : "Odin"}
					</span>
				</ZoomStable>
				{/* Which set of accounts is live. Next to the app name because it
				    changes what every view below is showing, not just one feed.
				    A plain <select> - it opens as a native menu, it's keyboard
				    navigable for free, and there is nothing to style on the popup.
				    Creating and deleting profiles lives in Settings → Connections,
				    next to the credentials they hold. */}
				{profiles.length > 0 && (
					<ZoomStable enabled={isMac}>
						<select
							aria-label="Profile"
							title="The accounts Odin is reading - its Slack, Jira, GitHub, sessions and tasks"
							value={activeProfileId}
							disabled={isSwitchingProfile}
							onChange={(event) => switchProfile(event.target.value)}
							className="cursor-pointer rounded-[6px] bg-secondary px-1.5 py-[3px] text-[11px] font-semibold text-muted-foreground outline-none transition-colors hover:text-foreground disabled:opacity-50"
						>
							{profiles.map((profile) => {
								// A native <option> is text and nothing else - no dot, no
								// badge - so the counts go in the label. Only on the
								// profiles you're NOT on: the active one's are already on
								// the board below, and the selected option is what the
								// closed button shows.
								return (
									<option key={profile.id} value={profile.id}>
										{profile.id === activeProfileId
											? profile.name
											: profileLabel(
													profile.name,
													boardCountsByProfile.get(profile.id),
												)}
									</option>
								);
							})}
						</select>
					</ZoomStable>
				)}
				{/* The option labels only show once the menu is open; this is what
				    the closed picker says. One pill per busy profile - sharing one
				    pill ran "Private · 1 needs you test · 1 needs you" together.
				    Amber when something there is waiting on you, quiet when it's
				    only working. Click jumps to that profile. */}
				{otherProfilesBusy.map((profile) => (
					<ZoomStable key={profile.id} enabled={isMac}>
						<button
							type="button"
							disabled={isSwitchingProfile}
							onClick={() => switchProfile(profile.id)}
							title={`Switch to ${profile.name}`}
							className={cn(
								"ml-1.5 rounded-full px-2 py-[2px] text-[11px] font-semibold tabular-nums disabled:opacity-50",
								profile.needsYou > 0
									? PILL.attention
									: "bg-secondary text-muted-foreground",
							)}
						>
							{profileLabel(profile.name, profile)}
						</button>
					</ZoomStable>
				))}
				<div className="h-full min-w-0 flex-1 [-webkit-app-region:drag]" />
				{/* The board's Sessions / Board view toggle portals in here: centred
				    in the free space between two drag fillers, so a narrow window
				    shrinks the fillers instead of sliding the toggle over the
				    status badges. It never moves when the session drawer opens.
				    z-50: above the drawer's full-window backdrop (z-40), or a click
				    closes the drawer. */}
				<div className="relative z-50 shrink-0">
					<ZoomStable enabled={isMac}>
						<div id="odin-view-toggle" />
					</ZoomStable>
				</div>
				<div className="h-full min-w-0 flex-1 [-webkit-app-region:drag]" />
				<ZoomStable enabled={isMac}>
					<div className="flex items-center gap-1.5">
						<ClaudeCommandPicker />
						<StatusPill
							usage={usage}
							thisMac={load && loadStatus(load, limits, freeing)}
							remoteHosts={remoteHosts}
							onClick={diskFull ? () => void freeDisk() : undefined}
						/>
					</div>
				</ZoomStable>
			</div>
			<UpdateBanner />
			<ClaudeSignInBanner />

			<div className="flex min-h-0 flex-1">
				{/* icon rail - scrolls when zoomed in past its height, or the bottom
				    icons (Settings, the raven) clip off with no way back to them. */}
				<div className="hide-scrollbar flex w-[52px] shrink-0 flex-col items-center gap-1.5 overflow-y-auto border-r border-border bg-tertiary/70 py-2.5 [&>*]:shrink-0">
					{RAIL_ITEMS.map(renderRailItem)}
					<DropdownMenu>
						<Tooltip delayDuration={300}>
							<TooltipTrigger asChild>
								<DropdownMenuTrigger asChild>
									<button
										type="button"
										aria-label="More"
										className={cn(
											"flex size-9 items-center justify-center rounded-[9px] transition-colors",
											isMoreActive
												? BUTTON.selected
												: "text-muted-foreground hover:text-foreground",
										)}
									>
										<HiOutlineEllipsisVertical className="size-[17px]" />
									</button>
								</DropdownMenuTrigger>
							</TooltipTrigger>
							<TooltipContent side="right">More</TooltipContent>
						</Tooltip>
						<DropdownMenuContent side="right" align="start" className="w-52">
							{MORE_ITEMS.map(({ to, hotkey, label, Icon }) => (
								<DropdownMenuItem key={to} onSelect={() => navigate({ to })}>
									<Icon className="size-4" />
									{label}
									<DropdownMenuShortcut>
										{railHotkeys[hotkey].text}
									</DropdownMenuShortcut>
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
					<div className="flex-1" />
					{renderRailItem(SETTINGS_ITEM)}
					<CrowButton
						open={isCrowOpen}
						onOpen={() => setCrowOpen(true)}
						onClose={() => setCrowOpen(false)}
						onAsk={askCrow}
						onResume={resumeCrow}
						keys={crowKeys.text}
						conversation={openCrow}
						onShowOnBoard={(paneId) => {
							setCrowOpen(false);
							usePendingFocus.getState().focus(paneId);
							navigate({ to: "/board" });
						}}
					/>
				</div>

				{/* `relative`: the page drawers anchor to this area, not the viewport,
				    so they can't slide under the native traffic lights. */}
				<div className="relative min-w-0 flex-1 overflow-hidden">
					<div className="h-full">
						<Outlet />
					</div>
					<GettingStarted
						onAddTask={() => setIsQuickAddOpen(true)}
						newTaskKeys={newTaskKeys.text}
					/>
					<InAppBrowser />
				</div>
			</div>

			<SessionContextDialog />
			{isQuickAddOpen && <QuickAddTask onClose={closeQuickAdd} />}
			{isSearchAllOpen && (
				<SearchAll onClose={() => setIsSearchAllOpen(false)} />
			)}
		</div>
	);
}

/**
 * Claude usage, this Mac and each remote host in one pill. The bar shows only
 * what's amber or red, worst first; hover lists everything. With nothing
 * wrong it shrinks to a dot. Remote hosts are read from the readings their
 * panes send every 30s, so it costs a host nothing more. A host you moved
 * away from stays listed while its sessions finish.
 */
function StatusPill({
	usage,
	thisMac,
	remoteHosts,
	onClick,
}: {
	usage: ClaudeUsage | null;
	thisMac: StatusItem | null;
	remoteHosts: [string, number][];
	/** Set while the disk is full: a click deletes unused worktrees. */
	onClick?: () => void;
}) {
	const gates = electronTrpc.useQueries((t) =>
		remoteHosts.map(([host]) =>
			t.remoteHost.launchGate({ host }, { refetchInterval: 15_000 }),
		),
	);
	const minFreeDiskGb = useLaunchLimits((s) => s.minFreeDiskGb);
	const items: StatusItem[] = [
		usage?.fiveHour && usageStatus("5h", "5-hour window", usage.fiveHour),
		usage?.week && usageStatus("week", "This week", usage.week),
		thisMac,
		...remoteHosts.map(([host, sessions], i): StatusItem => {
			const gate = gates[i]?.data;
			if (gate?.frozen)
				return {
					tone: "danger",
					bar: `${host} out of memory · sessions frozen`,
					detail: gate.frozen,
				};
			if (gate?.reason)
				return {
					tone: "attention",
					bar: `${gate.reason} · launches there wait`,
					detail: `${gate.reason} - new sessions there wait until that clears.`,
				};
			const diskLow =
				gate?.diskFreeGb != null && gate.diskFreeGb < minFreeDiskGb + 20;
			return {
				tone: diskLow ? "attention" : "ok",
				bar: diskLow ? `${host} disk ${gate.diskFreeGb} GB` : "",
				detail: `${host}: ${sessions} session(s).${gate?.freeGb != null ? ` It has ${gate.freeGb} GB free.` : " No memory reading yet."}${gate?.diskFreeGb != null ? ` Disk ${gate.diskFreeGb} GB free.` : ""}`,
			};
		}),
	].filter((item): item is StatusItem => !!item);
	if (items.length === 0) return null;
	const warnings = [
		...items.filter((item) => item.tone === "danger"),
		...items.filter((item) => item.tone === "attention"),
	];
	const tone = warnings[0]?.tone ?? "ok";
	return (
		<Tooltip delayDuration={300}>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label="Usage and machine status"
					onClick={onClick}
					className={cn(
						"flex h-[22px] items-center rounded-[6px] px-2 text-[11px] font-semibold tabular-nums",
						onClick ? "hover:brightness-125" : "cursor-default",
						TONE_PILL[tone],
					)}
				>
					{warnings.length > 0 ? (
						warnings.map((item) => item.bar).join(" · ")
					) : (
						<span className="size-1.5 rounded-full bg-success" />
					)}
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="max-w-[320px] space-y-1">
				{items.map((item) => (
					<p key={item.detail} className={TONE_TEXT[item.tone]}>
						{item.detail}
					</p>
				))}
				{onClick && <p>Click to delete unused worktrees.</p>}
			</TooltipContent>
		</Tooltip>
	);
}
