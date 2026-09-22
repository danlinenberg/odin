import { Tooltip, TooltipContent, TooltipTrigger } from "@odin/ui/tooltip";
import { cn } from "@odin/ui/utils";
import {
	createFileRoute,
	Outlet,
	useMatchRoute,
	useNavigate,
} from "@tanstack/react-router";
import { useState } from "react";
import {
	HiOutlineBolt,
	HiOutlineChartBar,
	HiOutlineClipboardDocumentCheck,
	HiOutlineClipboardDocumentList,
	HiOutlineClock,
	HiOutlineCog6Tooth,
	HiOutlineViewColumns,
} from "react-icons/hi2";
import { ZoomStable } from "renderer/components/ZoomStable/ZoomStable";
import { useTaskQueue } from "renderer/hooks/useTaskQueue";
import { useZoomFactor } from "renderer/hooks/useZoomFactor";
import { useHotkey } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	BUSY_AGENT_CPU_PERCENT,
	BUSY_HOST_CPU_PERCENT,
	type MachineLoad,
	machineLoad,
} from "shared/machine-load";
import { FEED_TABS } from "./components/feed-counts";
import { QuickAddTask } from "./components/TaskBox";
import { useAutomationRunner } from "./hooks/useAutomationRunner";
import { useNeedsYouByProfile } from "./hooks/useNeedsYouByProfile";
import { useOdinFeeds } from "./hooks/useOdinFeeds";
import { useOdinProfile } from "./hooks/useOdinProfile";

/**
 * Odin's shell — minimal chrome for the Dev Board, My Tasks, Slack, Session
 * History, My Jira and My PRs views:
 * slim icon rail + top bar, fixed dark palette (independent of app theme),
 * matching the agreed mock rather than the stock dashboard.
 */

export const Route = createFileRoute("/_authenticated/_odin")({
	component: OdinShell,
});

/**
 * The rail, in order. Every feed — my own tasks, Slack, Jira, PRs, Notion,
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
	// Also its own entry rather than a feed tab. The strip answers "what's
	// waiting on me" from a source; this answers "what can go", and its rows
	// are verdicts about the other tabs rather than a seventh queue.
	{
		to: "/review" as const,
		hotkey: "ODIN_REVIEW" as const,
		label: "Review",
		Icon: HiOutlineClipboardDocumentList,
	},
	// Its own rail entry, not a seventh feed tab: every tab in that strip
	// answers "what's waiting on me", and an automation is the one thing that
	// isn't — it runs itself.
	{
		to: "/automations" as const,
		hotkey: "ODIN_AUTOMATIONS" as const,
		label: "Automations",
		Icon: HiOutlineBolt,
	},
];

/**
 * Settings is app chrome, not a feed — foot of the rail. The stock entry point
 * lives in the sidebar this fork redirects away from, so without this the
 * settings screen (rail key rebinding included) is unreachable by mouse.
 */
const SETTINGS_ITEM = {
	to: "/settings" as const,
	hotkey: "OPEN_SETTINGS" as const,
	label: "Settings",
	Icon: HiOutlineCog6Tooth,
};

/** Insights reads the logs rather than being one — it sits with History. */
const INSIGHTS_ITEM = {
	to: "/insights" as const,
	hotkey: "ODIN_INSIGHTS" as const,
	label: "Insights",
	Icon: HiOutlineChartBar,
};

/** History is a log, not a feed — it sits alone at the foot of the rail. */
const HISTORY_ITEM = {
	to: "/sessions" as const,
	hotkey: "ODIN_SESSIONS" as const,
	label: "Session History",
	Icon: HiOutlineClock,
};

/**
 * Single-key nav: bare keys, so they must not fire while you're typing.
 * react-hotkeys-hook skips form tags and contenteditable when told to — which
 * also covers xterm's hidden textarea, i.e. the embedded agent terminals.
 */
const NAV_HOTKEY_OPTIONS = {
	enableOnFormTags: false,
	enableOnContentEditable: false,
} as const;

/**
 * The load badge's colour: the app's own status palette, walked up as the Mac
 * gets tighter — grey while there's slack, amber when it's filling up, red
 * when agents are queueing or the memory is gone.
 *
 * ponytail: the CPU steps off the two numbers that actually gate a launch —
 * agents' share and the whole machine's; the GB are eyeballed thresholds that
 * only pick a colour, so nothing rides on them being exactly right.
 */
function badgeTone(load: MachineLoad): string {
	if (load.busy || load.availableMemoryGb < 1) {
		return "bg-[#3a1a20] text-[#f0647a]";
	}
	if (
		load.agentCpuPercent >= BUSY_AGENT_CPU_PERCENT / 2 ||
		load.cpuPercent >= BUSY_HOST_CPU_PERCENT - 15 ||
		load.availableMemoryGb < 2
	) {
		return "bg-[#3a2f16] text-[#f5b83d]";
	}
	return "bg-[#1f1f27] text-[#8a8a97]";
}

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

	// What the agents are costing this Mac — the same reading that decides
	// whether a new session starts now or waits (see useLaunchTaskSession).
	const { data: metrics } = electronTrpc.resourceMetrics.getSnapshot.useQuery(
		undefined,
		{ refetchInterval: 5_000 },
	);
	const load = metrics ? machineLoad(metrics) : null;

	// The accounts in play. Switching resets every query, so the feeds below
	// refetch against the new profile's Slack/Jira/GitHub rather than showing
	// the old profile's rows under the new name.
	const {
		activeId: activeProfileId,
		profiles,
		switchTo: switchProfile,
		isSwitching: isSwitchingProfile,
	} = useOdinProfile();
	// A session waiting on you under the *other* profile is invisible until you
	// switch — the board only draws one profile's cards. The picker says so.
	const needsYouByProfile = useNeedsYouByProfile();

	// Sync every feed (Slack, Jira, PRs, Notion) as soon as the app
	// opens — the
	// shell mounts on boot and on reload — so switching views shows rows
	// instead of an empty "syncing…".
	useOdinFeeds();

	// The clock behind the Automations panel. Here rather than on that page:
	// a schedule that only runs while you're looking at it isn't one.
	useAutomationRunner();
	// Same reason: tasks held back by the capacity gate wait in Idle → Queued,
	// and this is what starts them once the Mac (or Odin's checkout) frees up.
	useTaskQueue();

	const { data: workConfig } = electronTrpc.work.getConfig.useQuery();
	// Single-key nav — D board, T tasks, S slack, H history, J jira, P PRs
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
		// Modifier chord (⌘,), so it stays live inside terminals and inputs —
		// hence the default options rather than NAV_HOTKEY_OPTIONS.
		OPEN_SETTINGS: useHotkey("OPEN_SETTINGS", () =>
			navigate({ to: "/settings" }),
		),
	};

	// Write a task down from wherever you are — a chord too, so it reaches you
	// inside a session's terminal, which is where most of them occur to you.
	const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
	useHotkey("ODIN_NEW_TASK", () => setIsQuickAddOpen(true));

	const renderRailItem = ({
		to,
		label,
		hotkey,
		Icon,
	}:
		| (typeof RAIL_ITEMS)[number]
		| typeof INSIGHTS_ITEM
		| typeof HISTORY_ITEM
		| typeof SETTINGS_ITEM) => {
		// Tasks stands for every feed: lit on any of them, and always opening on
		// All — every source at once is the answer to "what's waiting on me".
		const isFeeds = to === "/all";
		const isActive = isFeeds ? isFeedRoute : !!matchRoute({ to, fuzzy: true });
		const keys = railHotkeys[hotkey].text;
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
								? "bg-[#1f1f27] text-[#f5f5f7] shadow-[inset_0_0_0_1px_#25252e]"
								: "text-[#a5a5b3] hover:text-[#f5f5f7]",
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
		<div className="flex h-full w-full flex-col bg-[#0a0a0c] text-[#f5f5f7]">
			{/* top bar — left pad clears macOS traffic lights; empty areas drag.
			    The traffic lights are native and DON'T scale with page zoom, so the
			    bar height and their inset are counter-scaled by 1/zoomFactor to stay
			    a constant physical size (otherwise zooming out slides the bar under
			    the lights). Same trick the stock TopBar uses. */}
			<div
				className="flex shrink-0 items-center gap-3 border-b border-[#25252e] bg-[#111114] pr-3"
				style={isMac ? { height: `${36 / zoomFactor}px` } : undefined}
			>
				<div
					className="h-full shrink-0 [-webkit-app-region:drag]"
					style={{ width: isMac ? `${84 / zoomFactor}px` : "16px" }}
				/>
				<ZoomStable enabled={isMac}>
					<span className="text-xs font-semibold text-[#f5f5f7]">
						{workConfig?.isDev ? "Odin Dev" : "Odin"}
					</span>
				</ZoomStable>
				{/* Which set of accounts is live. Next to the app name because it
				    changes what every view below is showing, not just one feed.
				    A plain <select> — it opens as a native menu, it's keyboard
				    navigable for free, and there is nothing to style on the popup.
				    Creating and deleting profiles lives in Settings → Connections,
				    next to the credentials they hold. */}
				{profiles.length > 0 && (
					<ZoomStable enabled={isMac}>
						<select
							aria-label="Profile"
							title="The accounts Odin is reading — its Slack, Jira, GitHub, sessions and tasks"
							value={activeProfileId}
							disabled={isSwitchingProfile}
							onChange={(event) => switchProfile(event.target.value)}
							className="cursor-pointer rounded-[6px] bg-[#1f1f27] px-1.5 py-[3px] text-[11px] font-semibold text-[#a5a5b3] outline-none transition-colors hover:text-[#f5f5f7] disabled:opacity-50"
						>
							{profiles.map((profile) => {
								// A native <option> is text and nothing else — no dot, no
								// badge — so the count goes in the label. Only on the
								// profiles you're NOT on: the active one's needs-you is
								// already on the board below, and the selected option is
								// what the closed button shows.
								const needsYou =
									profile.id === activeProfileId
										? 0
										: (needsYouByProfile.get(profile.id) ?? 0);
								return (
									<option key={profile.id} value={profile.id}>
										{needsYou > 0
											? `${profile.name} · ${needsYou} needs you`
											: profile.name}
									</option>
								);
							})}
						</select>
					</ZoomStable>
				)}
				<div className="h-full min-w-0 flex-1 [-webkit-app-region:drag]" />
				<ZoomStable enabled={isMac}>
					<div className="flex items-center gap-1.5">
						{/* What the agents hold and what the Mac has left — every
						    build, not just internal ones: "can I start another?" is a
						    question on a stable release too. Two measurements, no
						    forecast: see MachineLoad.availableMemoryGb. */}
						{load && (
							<span
								title={
									load.busy
										? `${load.reason} — new sessions wait until that clears. ${load.agentCount} session(s) using ${load.agentMemoryGb} GB; this Mac is ${load.cpuPercent}% busy with ${load.availableMemoryGb} GB free.`
										: `${load.agentCount} session(s) using ${load.agentMemoryGb} GB of memory. This Mac has ${load.availableMemoryGb} GB free. Agents are on ${load.agentCpuPercent}% of the CPU · this Mac is ${load.cpuPercent}% busy.`
								}
								className={cn(
									"rounded-[6px] px-2 py-[3px] text-[11px] font-semibold tabular-nums",
									badgeTone(load),
								)}
							>
								{load.busy
									? `${load.reason} · launches waiting`
									: `${load.agentCount} ${load.agentCount === 1 ? "session" : "sessions"} using ${load.agentMemoryGb} GB · ${load.availableMemoryGb} GB free`}
							</span>
						)}
					</div>
				</ZoomStable>
			</div>

			<div className="flex min-h-0 flex-1">
				{/* icon rail */}
				<div className="flex w-[52px] shrink-0 flex-col items-center gap-1.5 border-r border-[#25252e] bg-[#111114] py-2.5">
					{RAIL_ITEMS.map(renderRailItem)}
					<div className="flex-1" />
					{renderRailItem(INSIGHTS_ITEM)}
					{renderRailItem(HISTORY_ITEM)}
					{renderRailItem(SETTINGS_ITEM)}
				</div>

				{/* `relative`: the page drawers anchor to this area, not the viewport,
				    so they can't slide under the native traffic lights. */}
				<div className="relative min-w-0 flex-1 overflow-hidden">
					<div className="h-full">
						<Outlet />
					</div>
				</div>
			</div>

			{isQuickAddOpen && (
				<QuickAddTask onClose={() => setIsQuickAddOpen(false)} />
			)}
		</div>
	);
}
