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
	FeedSelect,
	FilterPill,
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
	RowActions,
	SyncButton,
} from "../components/FeedChrome";
import { FEED_TABS, type FeedPath } from "../components/feed-counts";
import {
	HiddenToggle,
	HideButton,
	useHiddenFilter,
} from "../components/HiddenItems";
import { PersonChip } from "../components/PersonChip";
import {
	DueChip,
	isDue,
	META_DUE,
	useReminders,
} from "../components/Reminders";
import { PriorityLabelChip } from "../components/TaskBox";
import { useActiveSessions } from "../hooks/useActiveSessions";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useMyTasks } from "../hooks/useOdinTasks";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { PANE_STATUS } from "../pane-status";
import { type AllItem, allItems, type Urgency } from "./all-items";

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
 * Rows are filtered, not just listed: by source, by how urgent they are in
 * whatever terms their system uses, and by where they live — the channel, the
 * repo, the project. And anything that isn't yours to do can be hidden, under
 * the same key its own feed hides it with.
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
	// Parked is a state, not a source — a session from any feed can be in it,
	// and the board's own section is where that's visible. Reading it as a task
	// keeps the row honest about the one thing it can say for sure: it isn't a
	// feed item.
	parked: { to: "/my-tasks", source: "Tasks" },
};

/** What a live session is doing — the board's columns, as a chip. */
const SESSION_STATE: Partial<
	Record<PaneStatus, { label: string; dot: string }>
> = {
	permission: { label: "needs you", dot: PANE_STATUS.permission.dot },
	working: { label: "working", dot: PANE_STATUS.working.dot },
	review: { label: "done", dot: PANE_STATUS.review.dot },
	idle: { label: "idle", dot: PANE_STATUS.idle.dot },
};

/**
 * Which system a row came from, at a glance. Live sessions own green, and
 * Tasks keeps the app's own accent. Slack takes the crimson out of its logo
 * rather than another violet — two purples a shade apart aren't a distinction.
 */
const SOURCE_CHIP: Record<AllItem["source"], string> = {
	Tasks: "bg-[#211d3a] text-[#a394ff]",
	Slack: "bg-[#361d28] text-[#ff8fae]",
	Jira: "bg-[#16283a] text-[#7ec4ff]",
	GitHub: "bg-[#3a2c14] text-[#f5b83d]",
	Notion: "bg-[#1f1f27] text-[#c8c8d2]",
};

/** The source filter, in the order the tab strip lists them. ponytail: a
 * picker, not pills — the tab strip above already draws one row of sources,
 * and a second row of the same names read as two of the same control. */
const SOURCES = ["Tasks", "Slack", "Jira", "GitHub", "Notion"] as const;

/** The urgency filter's options — "none" is the rows their source never rated. */
const URGENCIES: { id: Exclude<Urgency, null> | "none"; label: string }[] = [
	{ id: "high", label: "High" },
	{ id: "medium", label: "Medium" },
	{ id: "low", label: "Low" },
	{ id: "none", label: "Unrated" },
];

function AllFeedPage() {
	const { reactions, jira, pulls, notion, syncAll, isSyncing } = useOdinFeeds();
	const navigate = useNavigate();
	// ponytail: local state, so it starts collapsed every visit — that's the ask.
	const [showSessions, setShowSessions] = useState(false);
	// The three ways to cut the list. Local state too: All is the "what have I
	// got on" view, and it should open saying everything, every time.
	const [source, setSource] = useState<AllItem["source"] | "">("");
	const [urgency, setUrgency] = useState("");
	const [context, setContext] = useState("");
	// A fourth cut, but a toggle rather than a select: "what's due" has one
	// answer, and it's the one you want on the morning something is late.
	const [dueOnly, setDueOnly] = useState(false);
	const reminders = useReminders((s) => s.reminders);
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching, launchingKey } = useLaunchTaskSession();
	// todos, not tasks: automations have their own panel and run themselves —
	// they'd sit in "what have I got on" forever without ever being yours to do.
	const { todos, setPane } = useMyTasks();
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

	const allRows = useMemo(
		() =>
			allItems({
				tasks: todos,
				slack: reactions.data?.rows ?? [],
				jira: jira.data?.issues ?? [],
				pulls: pulls.data?.pulls ?? [],
				notion: notion.data?.rows ?? [],
			}),
		[todos, reactions.data, jira.data, pulls.data, notion.data],
	);

	// Hidden rows drop out first, so every count below says what's on screen.
	// No prefix: an All key already names its source, and it's the same key the
	// source's own feed hides under.
	const hide = useHiddenFilter("", allRows, (item) => item.key);

	const sourceCounts = useMemo(() => {
		const counts = new Map<AllItem["source"], number>();
		for (const item of hide.rows)
			counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
		return counts;
	}, [hide.rows]);

	const bySource = useMemo(
		() =>
			source ? hide.rows.filter((item) => item.source === source) : hide.rows,
		[hide.rows, source],
	);

	// Both pickers count what picking them would leave, against the filters
	// above them — urgency within the chosen source, place within both.
	const urgencyCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const item of bySource) {
			const id = item.urgency ?? "none";
			counts.set(id, (counts.get(id) ?? 0) + 1);
		}
		return counts;
	}, [bySource]);

	const byUrgency = useMemo(
		() =>
			urgency
				? bySource.filter((item) => (item.urgency ?? "none") === urgency)
				: bySource,
		[bySource, urgency],
	);

	/** Channels, repos, projects — whatever the remaining rows call home. */
	const places = useMemo(() => {
		const counts = new Map<string, number>();
		for (const item of byUrgency)
			if (item.context)
				counts.set(item.context, (counts.get(item.context) ?? 0) + 1);
		return [...counts.entries()].sort(
			(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
		);
	}, [byUrgency]);

	const byContext = useMemo(
		() =>
			context
				? byUrgency.filter((item) => item.context === context)
				: byUrgency,
		[byUrgency, context],
	);

	// Counted over everything on screen rather than the current cut: a ticket
	// that went overdue under a filter you aren't looking through still has to
	// be findable from here.
	const dueRows = useMemo(
		() => hide.rows.filter((item) => isDue(item.key, reminders, Date.now())),
		[hide.rows, reminders],
	);
	const items = useMemo(
		() =>
			dueOnly
				? byContext.filter((item) => isDue(item.key, reminders, Date.now()))
				: byContext,
		[byContext, dueOnly, reminders],
	);

	const isFiltered =
		source !== "" || urgency !== "" || context !== "" || dueOnly;
	const clearFilters = () => {
		setSource("");
		setUrgency("");
		setContext("");
		setDueOnly(false);
	};

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
					{items.length === hide.rows.length
						? `${hide.rows.length} waiting on you`
						: `${items.length} of ${hide.rows.length}`}
				</span>
				{sessions.length > 0 && (
					<span className="shrink-0 rounded-[10px] bg-[#14301f] px-1.5 py-[1px] text-[11px] font-semibold text-[#3ecf8e]">
						{sessions.length} live
					</span>
				)}
				<div className="ml-auto flex items-center gap-2.5">
					{isFiltered && (
						<button
							type="button"
							onClick={clearFilters}
							className="shrink-0 text-[12px] text-[#8a8a97] transition-colors hover:text-[#a5a5b3]"
						>
							clear filters
						</button>
					)}
					{dueRows.length > 0 && (
						<FilterPill
							active={dueOnly}
							count={dueRows.length}
							onClick={() => setDueOnly(!dueOnly)}
						>
							Due
						</FilterPill>
					)}
					<HiddenToggle
						count={hide.hiddenCount}
						showing={hide.showHidden}
						onToggle={() => hide.setShowHidden(!hide.showHidden)}
					/>
					<FeedSelect
						value={source}
						onChange={(value) => {
							setSource(value as AllItem["source"] | "");
							setContext("");
						}}
						title="Filter by source"
					>
						<option value="">Any source</option>
						{SOURCES.filter(
							// A source with nothing in it (Notion not connected, no PRs)
							// is an option that can only empty the list.
							(name) => (sourceCounts.get(name) ?? 0) > 0 || source === name,
						).map((name) => (
							<option key={name} value={name}>
								{name} ({sourceCounts.get(name) ?? 0})
							</option>
						))}
					</FeedSelect>
					<FeedSelect
						value={urgency}
						onChange={setUrgency}
						title="Filter by priority — every source's own words, in three levels"
					>
						<option value="">Any priority</option>
						{URGENCIES.map(({ id, label }) => (
							<option key={id} value={id}>
								{label} ({urgencyCounts.get(id) ?? 0})
							</option>
						))}
					</FeedSelect>
					{places.length > 0 && (
						<FeedSelect
							value={context}
							onChange={setContext}
							title="Filter by channel, repo or project"
						>
							<option value="">Everywhere</option>
							{places.map(([place, count]) => (
								<option key={place} value={place}>
									{place} ({count})
								</option>
							))}
						</FeedSelect>
					)}
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
						{isFiltered ? (
							<button
								type="button"
								onClick={clearFilters}
								className="underline-offset-2 hover:underline"
							>
								Nothing matches these filters — clear them
							</button>
						) : (
							"Nothing waiting on you 🎉"
						)}
					</div>
				)}
				{items.map((item) => {
					const url = item.url;
					const SourceIcon = SOURCE_ICON[item.to];
					const activePaneId = livePaneFor(item);
					return (
						<div
							key={item.key}
							className={cn(FEED_ROW, hide.isHidden(item) && "opacity-40")}
						>
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
									<span className={META_DUE}>
										<DueChip itemKey={item.key} title={item.title} />
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
								<RowActions>
									<HideButton
										hidden={hide.isHidden(item)}
										onClick={() => hide.toggle(item)}
									/>
								</RowActions>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
