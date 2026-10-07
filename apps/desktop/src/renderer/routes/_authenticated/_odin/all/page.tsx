import { cn } from "@odin/ui/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import type { IconType } from "react-icons";
import { emojify } from "renderer/lib/emoji";
import { openUrl } from "renderer/stores/in-app-browser";
import type { BoardSection } from "shared/board-section";
import type { PaneStatus } from "shared/tabs-types";
import { DoneButton } from "../components/DoneButton";
import {
	FEED_LIST,
	FEED_ROW,
	FeedDivider,
	FeedHeader,
	FeedSearch,
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
	ROW_PRIMARY_SLOT,
	ROW_START_BUTTON,
	SyncButton,
} from "../components/FeedChrome";
import { FEED_TABS, type FeedPath } from "../components/feed-counts";
import { PersonChip } from "../components/PersonChip";
import { PILL } from "../components/pill";
import {
	DueChip,
	effectiveDue,
	isDue,
	META_DUE,
	OverdueMark,
	useReminders,
} from "../components/Reminders";
import { PriorityLabelChip } from "../components/TaskBox";
import { useActiveSessions } from "../hooks/useActiveSessions";
import { useDone } from "../hooks/useDone";
import { useOdinFeeds } from "../hooks/useOdinFeeds";
import { useMyTasks } from "../hooks/useOdinTasks";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { PANE_STATUS } from "../pane-status";
import { type AllItem, allItems, type Urgency } from "./all-items";
import { TaskDetails } from "./TaskDetails";
import { useTitleOverrides } from "./title-overrides";
import { useStartAllItem } from "./use-start-item";

export const Route = createFileRoute("/_authenticated/_odin/all/")({
	component: AllFeedPage,
});

/**
 * All - every source in one list, newest first. The per-source tabs are for
 * working a queue; this is for the question they can't answer between them,
 * which is "what have I actually got on". Clicking a row goes to its feed,
 * where the Start session button lives.
 *
 * Every session running right now sits above them, whichever tab started it -
 * the per-source feeds each mark only their own rows live, and a Slack row
 * leaves its queue as soon as its session starts, so this is the one place
 * that can answer "what's already going".
 *
 * Rows are filtered, not just listed: by source, by how urgent they are in
 * whatever terms their system uses, and by where they live - the channel, the
 * repo, the project. And anything that isn't yours to do can be hidden, under
 * the same key its own feed hides it with.
 *
 * Rows start a session here too. Each feed's prompt builder is shared rather
 * than duplicated (feed-prompts.ts, thread-prompt.ts, notion/rows.ts), so a
 * row started from All is the same session the feed itself would have given
 * you - the launch payload is built in all-items.ts, where the source's own
 * fields still exist.
 */

/**
 * The tab strip's own mark for each feed, reused - a row's chip should say
 * "Slack" the same way the tab that opens Slack does.
 */
const SOURCE_ICON = Object.fromEntries(
	FEED_TABS.map(({ to, Icon }) => [to, Icon]),
) as Record<FeedPath, IconType>;

/**
 * A running session's source, in the same terms the rows use - the board's
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
	// Parked is a state, not a source - a session from any feed can be in it,
	// and the board's own section is where that's visible. Reading it as a task
	// keeps the row honest about the one thing it can say for sure: it isn't a
	// feed item.
	parked: { to: "/my-tasks", source: "Tasks" },
	// Same for these two board-only states.
	queued: { to: "/my-tasks", source: "Tasks" },
	recent: { to: "/my-tasks", source: "Tasks" },
};

/** What a live session is doing - the board's columns, as a chip. */
const SESSION_STATE: Partial<
	Record<PaneStatus, { label: string; dot: string }>
> = {
	permission: { label: "needs you", dot: PANE_STATUS.permission.dot },
	working: { label: "working", dot: PANE_STATUS.working.dot },
	review: { label: "done", dot: PANE_STATUS.review.dot },
	idle: { label: "idle", dot: PANE_STATUS.idle.dot },
};

/**
 * Which system a row came from. Every source draws the same neutral chip and
 * the icon tells them apart: when each source had its own colour, a list of
 * forty rows was a rainbow that outshouted the priority and due chips - the
 * colours that actually ask something of you.
 */
const SOURCE_CHIP = PILL.neutral;

/** The source filter, in the order the tab strip lists them. ponytail: a
 * picker, not pills - the tab strip above already draws one row of sources,
 * and a second row of the same names read as two of the same control. */
const SOURCES = [
	"Tasks",
	"Slack",
	"Jira",
	"GitHub",
	"Notion",
	"Email",
] as const;

/** The urgency filter's options - "none" is the rows their source never rated. */
const URGENCIES: { id: Exclude<Urgency, null> | "none"; label: string }[] = [
	{ id: "high", label: "High" },
	{ id: "medium", label: "Medium" },
	{ id: "low", label: "Low" },
	{ id: "none", label: "Unrated" },
];

function AllFeedPage() {
	const { reactions, jira, pulls, notion, emails, syncAll, isSyncing } =
		useOdinFeeds();
	const navigate = useNavigate();
	// ponytail: local state, so it starts collapsed every visit - that's the ask.
	const [showSessions, setShowSessions] = useState(false);
	// The three ways to cut the list. Local state too: All is the "what have I
	// got on" view, and it should open saying everything, every time.
	const [source, setSource] = useState<AllItem["source"] | "">("");
	const [urgency, setUrgency] = useState("");
	const [context, setContext] = useState("");
	// A fourth cut, but a toggle rather than a select: "what's due" has one
	// answer, and it's the one you want on the morning something is late.
	const [dueOnly, setDueOnly] = useState(false);
	// And free text, matched against everything a row shows - title, who, where,
	// status - so "terraform" or a colleague's name finds it without a picker.
	const [search, setSearch] = useState("");
	const needle = search.trim().toLowerCase();
	const reminders = useReminders((s) => s.reminders);
	// todos, not tasks: automations have their own panel and run themselves -
	// they'd sit in "what have I got on" forever without ever being yours to do.
	const { todos } = useMyTasks();
	const {
		start: handleStart,
		livePaneFor,
		isLaunching,
		launchingKey,
	} = useStartAllItem(() => void reactions.refetch());
	// What's already running, whichever tab started it. Each feed only marks its
	// own rows live, and a Slack row leaves its queue the moment a session
	// starts - so this is the only place "what have I got going" is answerable.
	const sessions = useActiveSessions();

	// Done rows - from any feed, Next in line, or a Review drop - aren't
	// waiting on you. They're one click away under "Done", with Undo.
	// Reading material is the same put-away, for rows with nothing left to do
	// but worth keeping: off every queue and the Night Agent, listed apart.
	const { isDone, markDone, markReading, undo, recent, reading } = useDone();
	const [shelf, setShelf] = useState<"done" | "reading" | null>(null);
	const shelfRows =
		shelf === "reading" ? reading : shelf === "done" ? recent : [];
	// Undo on the last row hides its pill too: back to the queue, not a blank.
	const showDone = shelfRows.length > 0;
	// The row whose details sit in the side panel. A title click opens it here
	// rather than jumping to the row's own feed tab, which dropped you out of
	// this list and left you hunting for the row again.
	const [openKey, setOpenKey] = useState<string | null>(null);
	const titles = useTitleOverrides((s) => s.titles);
	const allRows = useMemo(
		() =>
			allItems({
				tasks: todos,
				slack: reactions.data?.rows ?? [],
				jira: jira.data?.issues ?? [],
				pulls: pulls.data?.pulls ?? [],
				notion: notion.data?.rows ?? [],
				emails: emails.data?.emails ?? [],
			})
				.filter((item) => !isDone(item))
				.map((item) =>
					titles[item.key] ? { ...item, title: titles[item.key] } : item,
				),
		[
			titles,
			todos,
			reactions.data,
			jira.data,
			pulls.data,
			notion.data,
			emails.data,
			isDone,
		],
	);

	const sourceCounts = useMemo(() => {
		const counts = new Map<AllItem["source"], number>();
		for (const item of allRows)
			counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
		return counts;
	}, [allRows]);

	const bySource = useMemo(
		() => (source ? allRows.filter((item) => item.source === source) : allRows),
		[allRows, source],
	);

	// Both pickers count what picking them would leave, against the filters
	// above them - urgency within the chosen source, place within both.
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

	/** Channels, repos, projects - whatever the remaining rows call home. */
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
		() =>
			allRows.filter((item) =>
				isDue(effectiveDue(item.key, reminders, item.dueDate), Date.now()),
			),
		[allRows, reminders],
	);
	const items = useMemo(() => {
		const due = dueOnly
			? byContext.filter((item) =>
					isDue(effectiveDue(item.key, reminders, item.dueDate), Date.now()),
				)
			: byContext;
		if (!needle) return due;
		return due.filter((item) =>
			[
				item.title,
				item.person,
				item.context,
				item.status,
				item.source,
				item.mention?.text,
			]
				.join(" ")
				.toLowerCase()
				.includes(needle),
		);
	}, [byContext, dueOnly, reminders, needle]);

	// From every row, not the filtered ones: narrowing the list shouldn't shut
	// the panel you're reading. Marking it done does - it's gone from both.
	const openItem = allRows.find((item) => item.key === openKey);

	const isFiltered =
		source !== "" || urgency !== "" || context !== "" || dueOnly || !!needle;
	const clearFilters = () => {
		setSource("");
		setUrgency("");
		setContext("");
		setDueOnly(false);
		setSearch("");
	};

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<FeedDivider />
				<span className="shrink-0 text-[12px] text-muted-foreground">
					{items.length === allRows.length
						? `${allRows.length} waiting on you`
						: `${items.length} of ${allRows.length}`}
				</span>
				{sessions.length > 0 && (
					<span
						className={cn(
							"shrink-0 rounded-[10px] px-1.5 py-[1px] text-[11px] font-semibold",
							PILL.working,
						)}
					>
						{sessions.length} live
					</span>
				)}
				<div className="ml-auto flex items-center gap-2.5">
					{isFiltered && (
						<button
							type="button"
							onClick={clearFilters}
							className="shrink-0 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
						>
							clear filters
						</button>
					)}
					<FeedSearch value={search} onChange={setSearch} />
					{dueRows.length > 0 && (
						<FilterPill
							active={dueOnly}
							count={dueRows.length}
							onClick={() => setDueOnly(!dueOnly)}
						>
							Due
						</FilterPill>
					)}
					{reading.length > 0 && (
						<FilterPill
							active={shelf === "reading"}
							count={reading.length}
							onClick={() => setShelf(shelf === "reading" ? null : "reading")}
						>
							Reading material
						</FilterPill>
					)}
					{recent.length > 0 && (
						<FilterPill
							active={shelf === "done"}
							count={recent.length}
							onClick={() => setShelf(shelf === "done" ? null : "done")}
						>
							Done
						</FilterPill>
					)}
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
						title="Filter by priority - every source's own words, in three levels"
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

			<div className="flex min-h-0 flex-1">
				<div className={FEED_LIST}>
					{/* ponytail: no error banner here. A broken source already marks
				    its own tab, and fixing it happens on that tab - the roll-up
				    just shows the rows the other sources returned. */}
					{sessions.length > 0 && (
						<>
							<button
								type="button"
								onClick={() => setShowSessions((open) => !open)}
								className="flex items-center gap-1.5 px-1 pt-1 pb-0.5 text-[11px] font-semibold text-working"
							>
								<span className="size-1.5 animate-pulse rounded-full bg-current" />
								Live sessions
								<span className="rounded-[10px] bg-working/12 px-1.5 font-medium">
									{sessions.length}
								</span>
								<span className="text-muted-foreground">
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
														SOURCE_CHIP,
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
													className="min-w-0 flex-1 truncate bg-none text-left text-[13px] font-semibold text-foreground"
												>
													{emojify(session.title)}
												</button>
												{/* The same columns the rows below use, so a live
										    session says what its board card says: who it's
										    for, its tags, which repo it's in, what it's
										    doing. ponytail: no age column - the board's is a
										    transcript read per card, too much for a list. */}
												<div
													className={cn(
														"flex shrink-0 items-center gap-2 text-[11px]",
														openItem && "hidden",
													)}
												>
													<span className={META_TAG}>
														{session.tags[0] && (
															<span className="truncate font-mono text-[10.5px] text-faint-foreground">
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
													<span
														className={META_TEXT}
														title={session.repo ?? ""}
													>
														{session.repo}
													</span>
													{/* A live session has no date of its own, but the
												    empty slot keeps its due chip under the rows'. */}
													<span className={META_DATE} />
													<span className={META_DUE}>
														<DueChip
															itemKey={`session:${session.paneId}`}
															title={session.title}
														/>
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
							<div className="px-1 pt-2 pb-0.5 text-[11px] font-semibold text-muted-foreground">
								Waiting on you
							</div>
						</>
					)}
					{showDone && (
						<DoneList
							rows={shelfRows}
							verb={shelf === "reading" ? "saved" : "done"}
							onOpen={(url) => openUrl(url)}
							onUndo={undo}
						/>
					)}
					{!showDone && items.length === 0 && (
						<div className="px-2 py-8 text-center text-xs text-muted-foreground">
							{isFiltered ? (
								<button
									type="button"
									onClick={clearFilters}
									className="underline-offset-2 hover:underline"
								>
									Nothing matches these filters - clear them
								</button>
							) : (
								"Nothing waiting on you 🎉"
							)}
						</div>
					)}
					{!showDone &&
						items.map((item) => {
							const url = item.url;
							const SourceIcon = SOURCE_ICON[item.to];
							const activePaneId = livePaneFor(item);
							return (
								<div
									key={item.key}
									className={cn(
										FEED_ROW,
										item.key === openKey && "border-primary/50 bg-secondary/60",
									)}
								>
									{/* The same columns the per-source feeds use, so a row here
							    carries what its own feed would tell you: who it's from,
							    where it stands, where it lives. A grid, not a flex row,
							    so the mention below wraps inside the title's column. */}
									<div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto_auto_auto] items-center gap-x-3">
										<span
											className={cn(
												"flex w-[68px] shrink-0 items-center justify-center gap-1 rounded-[5px] px-[7px] py-[1px] text-[11px] font-semibold",
												SOURCE_CHIP,
											)}
										>
											<SourceIcon className="size-3 shrink-0" aria-hidden />
											{item.source}
										</span>
										<button
											type="button"
											title="Show details"
											onClick={() =>
												setOpenKey(item.key === openKey ? null : item.key)
											}
											className="min-w-0 flex-1 truncate bg-none text-left text-[13px] font-semibold text-foreground"
										>
											<OverdueMark itemKey={item.key} upstream={item.dueDate} />
											{emojify(item.title)}
										</button>
										{/* The open row's meta is in the panel, and with the panel
										    open the columns don't fit beside it - they squeezed the
										    title to nothing and pushed Done past the row's edge. */}
										<div
											className={cn(
												"flex shrink-0 items-center gap-2 text-[11px]",
												openItem && "hidden",
											)}
										>
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
												<DueChip
													itemKey={item.key}
													title={item.title}
													upstream={item.dueDate}
												/>
											</span>
										</div>
										<span className={ROW_LINK_SLOT}>
											{url && (
												<button
													type="button"
													title={url}
													onClick={() => openUrl(url)}
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
													className={ROW_START_BUTTON}
												>
													{launchingKey === item.launch.key
														? "Starting…"
														: "Start session"}
												</button>
											)}
										</span>
										<button
											type="button"
											onClick={() => markReading(item)}
											title="Nothing to do, but keep it - moves it to Reading material"
											className={ROW_LINK_BUTTON}
										>
											Read later
										</button>
										<DoneButton onClick={() => markDone(item)} />
										{/* Same preview the Jira feed shows: a mention row is there
								    because of one comment. Column 2 keeps it under the title. */}
										{item.mention && (
											<div className="col-start-2 mt-1.5 line-clamp-2 cursor-text select-text text-[11.5px] leading-relaxed text-muted-foreground">
												<span className="font-semibold text-soft-foreground">
													{item.mention.author ?? "Someone"}
													{": "}
												</span>
												{item.mention.text}
											</div>
										)}
									</div>
								</div>
							);
						})}
				</div>
				{openItem && (
					<DetailsPanel
						item={openItem}
						onClose={() => setOpenKey(null)}
						onOpenFeed={() => navigate({ to: openItem.to })}
					>
						<DetailsActions
							activePaneId={livePaneFor(openItem)}
							isLaunching={isLaunching}
							launching={launchingKey === openItem.launch.key}
							onStart={() => void handleStart(openItem)}
							onGoTo={(paneId) => {
								usePendingFocus.getState().focus(paneId);
								navigate({ to: "/board" });
							}}
							onReadLater={() => markReading(openItem)}
							onDone={() => markDone(openItem)}
						/>
					</DetailsPanel>
				)}
			</div>
		</div>
	);
}

/**
 * One row in full, beside the list - so reading a task doesn't cost you your
 * place in it. Its own feed and its upstream page stay one click away.
 */
function DetailsPanel({
	item,
	onClose,
	onOpenFeed,
	children,
}: {
	item: AllItem;
	onClose: () => void;
	onOpenFeed: () => void;
	children: ReactNode;
}) {
	const url = item.url;
	const rename = useTitleOverrides((s) => s.rename);
	return (
		<aside className="flex w-[380px] shrink-0 flex-col border-l border-border">
			<div className="flex shrink-0 items-center gap-2 px-3.5 pt-2 pb-1.5">
				<button
					type="button"
					onClick={onOpenFeed}
					className="text-[12px] font-semibold text-muted-foreground hover:text-foreground"
				>
					{item.source} feed →
				</button>
				{url && (
					<button
						type="button"
						title={url}
						onClick={() => openUrl(url)}
						className="text-[12px] font-semibold text-muted-foreground hover:text-foreground"
					>
						Open ↗
					</button>
				)}
				<button
					type="button"
					onClick={onClose}
					aria-label="Close details"
					className="ml-auto rounded-[7px] px-2 py-0.5 text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground"
				>
					✕
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-[18px]">
				<TaskDetails item={item} onRename={rename} />
			</div>
			{children}
		</aside>
	);
}

/** The row's own buttons, so a task read in the panel is acted on there. */
function DetailsActions({
	activePaneId,
	isLaunching,
	launching,
	onStart,
	onGoTo,
	onReadLater,
	onDone,
}: {
	activePaneId: string | null;
	isLaunching: boolean;
	launching: boolean;
	onStart: () => void;
	onGoTo: (paneId: string) => void;
	onReadLater: () => void;
	onDone: () => void;
}) {
	return (
		<div className="flex shrink-0 items-center gap-2 border-t border-border px-3.5 py-2.5">
			{activePaneId ? (
				<button
					type="button"
					onClick={() => onGoTo(activePaneId)}
					className={ROW_LIVE_BUTTON}
				>
					Go to session →
				</button>
			) : (
				<button
					type="button"
					disabled={isLaunching}
					onClick={onStart}
					className={ROW_START_BUTTON}
				>
					{launching ? "Starting…" : "Start session"}
				</button>
			)}
			<button
				type="button"
				onClick={onReadLater}
				title="Nothing to do, but keep it - moves it to Reading material"
				className={ROW_LINK_BUTTON}
			>
				Read later
			</button>
			<span className="ml-auto">
				<DoneButton onClick={onDone} />
			</span>
		</div>
	);
}

/** What was put away lately, newest first, as it looked then - with the way back. */
function DoneList({
	rows,
	verb,
	onOpen,
	onUndo,
}: {
	rows: ReturnType<typeof useDone>["recent"];
	verb: string;
	onOpen: (url: string) => void;
	onUndo: (row: ReturnType<typeof useDone>["recent"][number]) => void;
}) {
	return (
		<>
			{rows.map((row) => (
				<div key={row.key} className={FEED_ROW}>
					<div className="flex items-center gap-3">
						<span className="w-[68px] shrink-0 truncate text-[11px] font-semibold text-muted-foreground">
							{row.source}
						</span>
						<span
							dir="auto"
							className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground"
						>
							{emojify(row.title)}
						</span>
						<span className="shrink-0 text-[11px] text-muted-foreground">
							{verb}{" "}
							{new Date(row.at).toLocaleDateString(undefined, {
								month: "short",
								day: "numeric",
							})}
						</span>
						{row.url && /^https?:\/\//.test(row.url) && (
							<button
								type="button"
								onClick={() => row.url && onOpen(row.url)}
								className="shrink-0 text-[12px] font-semibold text-muted-foreground hover:text-foreground"
							>
								Open ↗
							</button>
						)}
						<button
							type="button"
							onClick={() => onUndo(row)}
							title="Put it back in the queue"
							className="shrink-0 rounded-[7px] px-2 py-1 text-[12px] font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground"
						>
							Undo
						</button>
					</div>
				</div>
			))}
		</>
	);
}
