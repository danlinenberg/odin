import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { IconType } from "react-icons";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { emojify } from "renderer/lib/emoji";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { BoardSection } from "shared/board-section";
import type { PaneStatus } from "shared/tabs-types";
import {
	FEED_LIST,
	FEED_ROW,
	FeedDivider,
	FeedHeader,
	META_DATE,
	META_PERSON,
	META_STATUS,
	META_TAG,
	META_TEXT,
	ROW_LINK_BUTTON,
	ROW_LINK_SLOT,
	ROW_LIVE_BUTTON,
	ROW_META,
	ROW_PRIMARY_BUTTON,
	ROW_PRIMARY_SLOT,
	SyncButton,
} from "../components/FeedChrome";
import { FEED_TABS, type FeedPath } from "../components/feed-counts";
import { PersonChip } from "../components/PersonChip";
import { PriorityLabelChip } from "../components/TaskBox";
import { useActiveSessions } from "../hooks/useActiveSessions";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useMyTasks } from "../hooks/useOdinTasks";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { type AllItem, allItems } from "./all-items";

export const Route = createFileRoute("/_authenticated/_odin/all/")({
	component: AllFeedPage,
});

/**
 * All — every source in one list, newest first. The per-source tabs are for
 * working a queue; this is for the question they can't answer between them,
 * which is "what have I actually got on". Clicking a row goes to its feed,
 * where the Start session button lives.
 *
 * Every session running right now sits above them, whichever tab started it —
 * the per-source feeds each mark only their own rows live, and a Slack row
 * leaves its queue as soon as its session starts, so this is the one place
 * that can answer "what's already going".
 *
 * Rows start a session here too. Each feed's prompt builder is shared rather
 * than duplicated (feed-prompts.ts, thread-prompt.ts, notion/rows.ts), so a
 * row started from All is the same session the feed itself would have given
 * you — the launch payload is built in all-items.ts, where the source's own
 * fields still exist.
 */

/**
 * The tab strip's own mark for each feed, reused — a row's chip should say
 * "Slack" the same way the tab that opens Slack does.
 */
const SOURCE_ICON = Object.fromEntries(
	FEED_TABS.map(({ to, Icon }) => [to, Icon]),
) as Record<FeedPath, IconType>;

/**
 * A running session's source, in the same terms the rows use — the board's
 * section names on one side, the feed that started it on the other. "normal"
 * is a session started from a prompt rather than a feed row.
 */
const SESSION_SOURCE: Record<
	BoardSection,
	{ to: FeedPath; source: AllItem["source"] }
> = {
	slack: { to: "/reactions", source: "Slack" },
	reactions: { to: "/reactions", source: "Slack" },
	jira: { to: "/jira", source: "Jira" },
	pr: { to: "/prs", source: "GitHub" },
	notion: { to: "/notion", source: "Notion" },
	normal: { to: "/my-tasks", source: "Tasks" },
};

/** What a live session is doing — the board's columns, as a chip. */
const SESSION_STATE: Partial<
	Record<PaneStatus, { label: string; dot: string }>
> = {
	permission: { label: "needs you", dot: "#f5b83d" },
	working: { label: "working", dot: "#5aa9ff" },
	review: { label: "done", dot: "#3ecf8e" },
	idle: { label: "idle", dot: "#f0647a" },
};

/** Which system a row came from, at a glance. Live sessions own green. */
const SOURCE_CHIP: Record<AllItem["source"], string> = {
	Tasks: "bg-[#211d3a] text-[#a394ff]",
	Slack: "bg-[#2a1d38] text-[#d59bff]",
	Jira: "bg-[#16283a] text-[#7ec4ff]",
	GitHub: "bg-[#3a2c14] text-[#f5b83d]",
	Notion: "bg-[#1f1f27] text-[#c8c8d2]",
};

function AllFeedPage() {
	const { reactions, jira, pulls, notion, syncAll, isSyncing } = useOdinFeeds();
	const navigate = useNavigate();
	// ponytail: local state, so it starts collapsed every visit — that's the ask.
	const [showSessions, setShowSessions] = useState(false);
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching, launchingKey } = useLaunchTaskSession();
	const { tasks, setPane } = useMyTasks();
	const panes = useTabsStore((s) => s.panes);
	// Starting a Slack row is what takes it out of the queue — the same call
	// the Slack feed makes, so a message started here doesn't come back.
	const markStarted = electronTrpc.slack.markStarted.useMutation({
		onSuccess: () => void reactions.refetch(),
	});
	// What's already running, whichever tab started it. Each feed only marks its
	// own rows live, and a Slack row leaves its queue the moment a session
	// starts — so this is the only place "what have I got going" is answerable.
	const sessions = useActiveSessions();

	const items = useMemo(
		() =>
			allItems({
				tasks,
				slack: reactions.data?.rows ?? [],
				jira: jira.data?.issues ?? [],
				pulls: pulls.data?.pulls ?? [],
				notion: notion.data?.rows ?? [],
			}),
		[tasks, reactions.data, jira.data, pulls.data, notion.data],
	);

	/**
	 * The pane already working this row, if there is one. Panes carry the page
	 * id for Slack/Notion and the launch title for everything else — matching
	 * both is what keeps Start session from opening a second agent on a ticket
	 * that already has one.
	 */
	const livePaneFor = (item: AllItem): string | null =>
		Object.values(panes).find(
			(pane) =>
				!pane.completed &&
				((item.launch.pageId != null &&
					pane.odinPageId === item.launch.pageId) ||
					pane.odinTaskTitle === item.launch.title),
		)?.id ?? null;

	const handleStart = async (item: AllItem) => {
		const ensured = await ensureWorkspace();
		if (!ensured.ok) return toast.error(ensured.error);
		const result = await launch({
			...item.launch,
			workspaceId: ensured.workspace.id,
		});
		if (!result.ok) return toast.error(result.error);
		if (item.source === "Slack") {
			markStarted.mutate({ id: item.launch.key });
			usePaneMeta.getState().setTitle(result.paneId, item.launch.title);
			usePaneMeta.getState().setSessionId(result.paneId, result.sessionId);
			usePaneMeta.getState().setPaneForPage(item.launch.key, result.paneId);
		}
		// My own tasks keep their row and gain a way into the session.
		if (item.source === "Tasks") setPane(item.launch.key, result.paneId);
		usePendingFocus.getState().focus(result.paneId);
		navigate({ to: "/board" });
	};

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<FeedDivider />
				<span className="shrink-0 text-[12px] text-[#8a8a97]">
					everything waiting on you · newest first · start one without leaving
				</span>
				{sessions.length > 0 && (
					<span className="shrink-0 rounded-[10px] bg-[#14301f] px-1.5 py-[1px] text-[11px] font-semibold text-[#3ecf8e]">
						{sessions.length} live
					</span>
				)}
				<div className="ml-auto flex items-center gap-2.5">
					<SyncButton isSyncing={isSyncing} onClick={() => void syncAll()} />
				</div>
			</FeedHeader>

			<div className={FEED_LIST}>
				{/* ponytail: no error banner here. A broken source already marks
				    its own tab, and fixing it happens on that tab — the roll-up
				    just shows the rows the other sources returned. */}
				{sessions.length > 0 && (
					<>
						<button
							type="button"
							onClick={() => setShowSessions((open) => !open)}
							className="flex items-center gap-1.5 px-1 pt-1 pb-0.5 text-[11px] font-semibold text-[#3ecf8e]"
						>
							<span className="size-1.5 animate-pulse rounded-full bg-current" />
							Live sessions
							<span className="rounded-[10px] bg-[#14301f] px-1.5 font-medium">
								{sessions.length}
							</span>
							<span className="text-[#8a8a97]">
								{showSessions ? "hide" : "show"}
							</span>
						</button>
						{showSessions &&
							sessions.map((session) => {
								const { to, source } = SESSION_SOURCE[session.source];
								const SourceIcon = SOURCE_ICON[to];
								const state = SESSION_STATE[session.column];
								return (
									<div key={session.paneId} className={FEED_ROW}>
										<div className="flex items-center gap-3">
											<span
												className={cn(
													"flex w-[68px] shrink-0 items-center justify-center gap-1 rounded-[5px] px-[7px] py-[1px] text-[11px] font-semibold",
													SOURCE_CHIP[source],
												)}
											>
												<SourceIcon className="size-3 shrink-0" aria-hidden />
												{source}
											</span>
											<button
												type="button"
												title="Open the session on the board"
												onClick={() => {
													usePendingFocus.getState().focus(session.paneId);
													navigate({ to: "/board" });
												}}
												className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold text-[#f5f5f7]"
											>
												{emojify(session.title)}
											</button>
											{/* The same columns the rows below use, so a live
										    session says what its board card says: who it's
										    for, its tags, which repo it's in, what it's
										    doing. ponytail: no age column — the board's is a
										    transcript read per card, too much for a list. */}
											<div className="flex shrink-0 items-center gap-2 text-[11px]">
												<span className={META_TAG}>
													{session.tags[0] && (
														<span className="truncate rounded-[5px] bg-[#211d3a] px-[7px] font-medium text-[#a394ff]">
															#{session.tags[0]}
														</span>
													)}
												</span>
												<span className={META_PERSON}>
													{session.contact && (
														<PersonChip
															name={session.contact}
															className="max-w-full truncate"
														/>
													)}
												</span>
												<span className={META_STATUS}>
													{state && (
														<span
															className={cn(
																ROW_META,
																"flex items-center gap-1.5",
															)}
														>
															<span
																className="size-1.5 rounded-full"
																style={{ backgroundColor: state.dot }}
															/>
															{state.label}
														</span>
													)}
												</span>
												<span className={META_TEXT} title={session.repo ?? ""}>
													{session.repo}
												</span>
											</div>
											<span className={ROW_PRIMARY_SLOT}>
												<button
													type="button"
													onClick={() => {
														usePendingFocus.getState().focus(session.paneId);
														navigate({ to: "/board" });
													}}
													className={ROW_LIVE_BUTTON}
												>
													Go to session →
												</button>
											</span>
										</div>
									</div>
								);
							})}
						<div className="px-1 pt-2 pb-0.5 text-[11px] font-semibold text-[#8a8a97]">
							Waiting on you
						</div>
					</>
				)}
				{items.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
						Nothing waiting on you 🎉
					</div>
				)}
				{items.map((item) => {
					const url = item.url;
					const SourceIcon = SOURCE_ICON[item.to];
					const activePaneId = livePaneFor(item);
					return (
						<div key={item.key} className={FEED_ROW}>
							{/* The same columns the per-source feeds use, so a row here
							    carries what its own feed would tell you: who it's from,
							    where it stands, where it lives. */}
							<div className="flex items-center gap-3">
								<span
									className={cn(
										"flex w-[68px] shrink-0 items-center justify-center gap-1 rounded-[5px] px-[7px] py-[1px] text-[11px] font-semibold",
										SOURCE_CHIP[item.source],
									)}
								>
									<SourceIcon className="size-3 shrink-0" aria-hidden />
									{item.source}
								</span>
								<button
									type="button"
									title={`Open the ${item.source} feed`}
									onClick={() => navigate({ to: item.to })}
									className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold text-[#f5f5f7]"
								>
									{emojify(item.title)}
								</button>
								<div className="flex shrink-0 items-center gap-2 text-[11px]">
									<span className={META_TAG}>
										{item.priority && (
											<PriorityLabelChip label={item.priority} />
										)}
									</span>
									<span className={META_PERSON}>
										{item.person && (
											<PersonChip
												name={item.person}
												className="max-w-full truncate"
											/>
										)}
									</span>
									<span className={META_STATUS}>
										{item.status && (
											<span className={cn(ROW_META, "truncate")}>
												{item.status}
											</span>
										)}
									</span>
									<span className={META_TEXT}>{item.context}</span>
									<span className={META_DATE}>
										{item.at > 0 &&
											new Date(item.at).toLocaleDateString(undefined, {
												month: "short",
												day: "numeric",
											})}
									</span>
								</div>
								<span className={ROW_LINK_SLOT}>
									{url && (
										<button
											type="button"
											title={url}
											onClick={() => openUrl.mutate(url)}
											className={ROW_LINK_BUTTON}
										>
											Open ↗
										</button>
									)}
								</span>
								<span className={ROW_PRIMARY_SLOT}>
									{activePaneId ? (
										<button
											type="button"
											onClick={() => {
												usePendingFocus.getState().focus(activePaneId);
												navigate({ to: "/board" });
											}}
											className={ROW_LIVE_BUTTON}
										>
											Go to session →
										</button>
									) : (
										<button
											type="button"
											disabled={isLaunching}
											onClick={() => void handleStart(item)}
											className={ROW_PRIMARY_BUTTON}
										>
											{launchingKey === item.launch.key
												? "Starting…"
												: "Start session"}
										</button>
									)}
								</span>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
