import { toast } from "@odin/ui/sonner";
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
	HiOutlineArrowPath,
	HiOutlineBolt,
	HiOutlineBoltSlash,
	HiOutlineChartBar,
	HiOutlineClipboardDocumentCheck,
	HiOutlineClock,
	HiOutlineCog6Tooth,
	HiOutlineViewColumns,
} from "react-icons/hi2";
import { ZoomStable } from "renderer/components/ZoomStable/ZoomStable";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { useZoomFactor } from "renderer/hooks/useZoomFactor";
import { useHotkey } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { machineLoad } from "shared/machine-load";
import { FEED_TABS } from "./components/feed-counts";
import {
	OdinPromptDialog,
	type PromptImage,
	sessionTitle,
} from "./components/OdinPromptDialog";
import { QuickAddTask } from "./components/TaskBox";
import { useNeedsYouByProfile } from "./hooks/useNeedsYouByProfile";
import { useOdinFeeds } from "./hooks/useOdinFeeds";
import { useOdinProfile } from "./hooks/useOdinProfile";
import { useOdinWorkspace } from "./hooks/useOdinWorkspace";
import { usePendingFocus } from "./hooks/usePendingFocus";

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

	// Self-update: rebuild + reinstall + relaunch from Odin's own checkout.
	const updateOdin = electronTrpc.work.updateOdin.useMutation();
	// Hot reload: run from source (instant renderer edits) and back again.
	const startDevMode = electronTrpc.work.startDevMode.useMutation();
	const exitDevMode = electronTrpc.work.exitDevMode.useMutation();
	const handleDevToggle = async () => {
		try {
			if (workConfig?.isDev) {
				await exitDevMode.mutateAsync();
				toast.success("Leaving hot reload — reopening the installed Odin");
			} else {
				const { logPath } = await startDevMode.mutateAsync();
				toast.success(
					"Starting hot reload — Odin will quit and reopen from source",
					{
						description: `Progress: ${logPath}`,
						duration: 10_000,
					},
				);
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};
	// Restart (dev only): main-process edits need a full restart, and re-running
	// the dev script is one — it quits the running stack first, daemon and open
	// sessions untouched. `settings.restartApp` would come back to a dead vite.
	const handleRestart = async () => {
		try {
			const { logPath } = await startDevMode.mutateAsync();
			toast.success("Restarting Odin — it will quit and reopen from source", {
				description: `Progress: ${logPath}`,
				duration: 10_000,
			});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};
	const handleUpdate = async () => {
		try {
			const { logPath } = await updateOdin.mutateAsync({ pull: false });
			toast.success("Rebuilding Odin — it will quit and relaunch itself", {
				description: `Progress: ${logPath}`,
				duration: 10_000,
			});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};

	// Change Odin with an agent: a session in Odin's own repo.
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch } = useLaunchTaskSession();
	const { data: workConfig } = electronTrpc.work.getConfig.useQuery();
	const [isComposerOpen, setIsComposerOpen] = useState(false);
	const workOnOdin = async (rawPrompt: string, images: PromptImage[]) => {
		const prompt = rawPrompt.trim();
		// Pin Odin's own checkout, not the default repo: the session opens IN the
		// source it's about, so the agent skips the "where do I live?" hunt.
		const ensured = await ensureWorkspace(workConfig?.odinRepoPath);
		if (!ensured.ok) {
			toast.error(ensured.error);
			return;
		}
		// The prompt names the session, so the board says what each one is doing.
		// Empty prompt still works: a bare conversational session, as before.
		const title = sessionTitle(prompt, "Work on Odin");
		const result = await launch({
			workspaceId: ensured.workspace.id,
			title,
			description: prompt && prompt !== title ? prompt : null,
			// Images alone are worth a prompt file — the paths have to reach the agent.
			noPrompt: !prompt && images.length === 0,
			images,
			brief: prompt || "Work on Odin itself (this app)",
			// Work on Odin is always #odin — no right-clicking the card to tag it.
			tags: ["odin"],
		});
		setIsComposerOpen(false);
		if (result.ok) {
			usePendingFocus.getState().focus(result.paneId);
			navigate({ to: "/board" });
		} else {
			toast.error(result.error);
		}
	};

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
						{workConfig?.isDev && (
							<span className="ml-1.5 font-normal text-[#8a8a97]">
								· hot reload
							</span>
						)}
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
										? `${load.agentCount} session(s) using ${load.agentCpuPercent}% of this Mac — new sessions wait until that clears.`
										: `${load.agentCount} session(s) using ${load.agentMemoryGb} GB of memory. This Mac has ${load.availableMemoryGb} GB free. Agents are on ${load.agentCpuPercent}% of the CPU · machine load ${load.cpuPercent}%.`
								}
								className={cn(
									"rounded-[6px] px-2 py-[3px] text-[11px] font-semibold tabular-nums",
									load.busy
										? "bg-[#3a1f24] text-[#f5b83d]"
										: "bg-[#1f1f27] text-[#8a8a97]",
								)}
							>
								{load.busy
									? `${load.agentCount} ${load.agentCount === 1 ? "session" : "sessions"} using ${load.agentCpuPercent}% CPU · launches waiting`
									: `${load.agentCount} ${load.agentCount === 1 ? "session" : "sessions"} using ${load.agentMemoryGb} GB · ${load.availableMemoryGb} GB free`}
							</span>
						)}
						{/* Self-development controls: only on a machine that has Odin's
						    checkout (ODIN_REPO_DIR / odinRepo in ~/.config/odin.json).
						    An installed build without one can't hot-reload or rebuild
						    itself anyway, so the buttons would only ever error. */}
						{workConfig?.isInternalBuild && workConfig?.odinRepoPath && (
							<>
								<button
									type="button"
									title={
										workConfig?.isDev
											? "Stop hot reload and reopen the installed Odin"
											: "Run Odin from source with hot reload (instant renderer edits)"
									}
									disabled={startDevMode.isPending || exitDevMode.isPending}
									onClick={() => void handleDevToggle()}
									className={cn(
										"flex items-center gap-1 rounded-[6px] px-2 py-[3px] text-[11px] font-semibold transition-colors disabled:opacity-50",
										workConfig?.isDev
											? "bg-[#6b5620]/40 text-[#f5b83d] hover:bg-[#6b5620]/60"
											: "bg-[#1f1f27] text-[#a5a5b3] hover:text-[#f5f5f7]",
									)}
								>
									{workConfig?.isDev ? (
										<>
											<HiOutlineBoltSlash className="size-3.5" />
											Exit hot reload
										</>
									) : (
										<>
											<HiOutlineBolt className="size-3.5" />
											Hot reload
										</>
									)}
								</button>
								{workConfig?.isDev && (
									<button
										type="button"
										title="Restart the dev app (picks up main-process changes; open sessions stay live)"
										disabled={startDevMode.isPending || exitDevMode.isPending}
										onClick={() => void handleRestart()}
										className="flex items-center gap-1 rounded-[6px] bg-[#1f1f27] px-2 py-[3px] text-[11px] font-semibold text-[#a5a5b3] transition-colors hover:text-[#f5f5f7] disabled:opacity-50"
									>
										<HiOutlineArrowPath className="size-3.5" />
										Restart Odin
									</button>
								)}
								<button
									type="button"
									title="Start an agent session in the Odin repo"
									onClick={() => setIsComposerOpen(true)}
									className="rounded-[6px] bg-[#1f1f27] px-2 py-[3px] text-[11px] font-semibold text-[#a5a5b3] transition-colors hover:text-[#f5f5f7]"
								>
									✎ Work on Odin
								</button>
								<button
									type="button"
									title="Rebuild Odin from its checkout, reinstall and relaunch"
									disabled={updateOdin.isPending}
									onClick={() => void handleUpdate()}
									className="rounded-[6px] bg-[#211d3a] px-2 py-[3px] text-[11px] font-semibold text-[#a394ff] transition-colors hover:bg-[#28224a] disabled:opacity-50"
								>
									{updateOdin.isPending ? "updating…" : "⟳ Update Odin"}
								</button>
							</>
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

			{isComposerOpen && (
				<OdinPromptDialog
					onCancel={() => setIsComposerOpen(false)}
					onSubmit={workOnOdin}
				/>
			)}

			{isQuickAddOpen && (
				<QuickAddTask onClose={() => setIsQuickAddOpen(false)} />
			)}
		</div>
	);
}
