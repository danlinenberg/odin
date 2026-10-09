import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@odin/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@odin/ui/dialog";
import { cn } from "@odin/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { IconType } from "react-icons";
import { HiOutlineBolt } from "react-icons/hi2";
import { isHotkey, useHotkeyDisplay } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { emojify } from "renderer/lib/emoji";
import { openUrl } from "renderer/stores/in-app-browser";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { AllItem } from "../all/all-items";
import { useSearchableItems } from "../all/use-all-items";
import { useStartAllItem } from "../all/use-start-item";
import { useDone } from "../hooks/useDone";
import { useOdinProfile } from "../hooks/useOdinProfile";
import { useMyTasks } from "../hooks/useOdinTasks";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { PANE_STATUS } from "../pane-status";
import { liveConversationIds } from "../sessions/live-sessions";
import { agoLabel, repoLabel } from "../sessions/row-labels";
import { ROW_META } from "./FeedChrome";
import { FEED_TABS } from "./feed-counts";
import {
	boardSessions,
	groupResults,
	matchRank,
	normalizeQuery,
	type Ranked,
	rankRows,
	rankSessions,
	type SearchableRow,
	type SessionHit,
	TRANSCRIPT_TIER,
} from "./search-all";

/** A row from a feed or the automations list - where it lives, and its mark. */
type PaletteRow = SearchableRow & { key: string; to: string; done: boolean };

/** What Session History's search hands back, as far as the palette reads it. */
interface PastSession {
	sessionId: string;
	title: string;
	person: string | null;
	cwd: string | null;
	updatedAt: number;
	snippets: { text: string }[];
}

type Hit =
	| { kind: "board"; session: SessionHit }
	| { kind: "row"; row: PaletteRow }
	| { kind: "history"; row: PastSession };

const wrapHits = <T,>(
	hits: Ranked<T>[],
	wrap: (item: T) => Hit,
): Ranked<Hit>[] => hits.map(({ item, tier }) => ({ item: wrap(item), tier }));

const SOURCES: { label: string; Icon: IconType }[] = [
	...FEED_TABS.filter(({ to }) => to !== "/all"),
	{ label: "Automations", Icon: HiOutlineBolt },
];
const SOURCE_ICON = new Map(SOURCES.map(({ label, Icon }) => [label, Icon]));
const BOARD = "Dev Board";
const HISTORY = "Session History";

/** Hits shown per source before "show more". */
const CAP = 8;

const ITEM = "gap-2.5 rounded-[7px] px-2.5 py-1.5 text-[13px]";

/** One line of a hit's ⌘K menu. */
interface Action {
	label: string;
	run: () => void;
}

const hitValue = (hit: Hit): string =>
	hit.kind === "board"
		? `board:${hit.session.paneId}`
		: hit.kind === "history"
			? `history:${hit.row.sessionId}`
			: hit.row.key;

const hitTitle = (hit: Hit): string =>
	hit.kind === "board" ? hit.session.title : hit.row.title;

/** Typing shouldn't fire a full transcript scan per keystroke. */
function useDebounced(value: string, ms: number): string {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), ms);
		return () => clearTimeout(timer);
	}, [value, ms]);
	return settled;
}

/**
 * Search all (⌘⇧F by default): one palette over every row any feed holds
 * (Done'd and closed ones too, ranked after the open ones), every card on the
 * Dev Board, the automations, and - from two characters - what was said in
 * every session Session History knows. One header per source, best source
 * first. A row opens its details on All, a card its drawer on the board, a
 * past session its transcript in Session History.
 */
export function SearchAll({ onClose }: { onClose: () => void }) {
	const actionKeys = useHotkeyDisplay("ODIN_SEARCH_ROW_MENU").text;
	const navigate = useNavigate();
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	// The highlighted row, and - after ⌘K on it - the hit whose actions show.
	const [active, setActive] = useState("");
	const [menuFor, setMenuFor] = useState<Hit | null>(null);
	const { start, livePaneFor } = useStartAllItem();
	const { markDone, markReading } = useDone();

	const feedRows = useSearchableItems();
	const { automations } = useMyTasks();
	const rows = useMemo<PaletteRow[]>(
		() => [
			...feedRows,
			...automations.map((task) => ({
				key: `automation:${task.id}`,
				to: "/automations",
				title: task.title,
				source: "Automations",
				person: null,
				context: task.cron ?? null,
				status: null,
				done: false,
			})),
		],
		[feedRows, automations],
	);

	const panes = useTabsStore((s) => s.panes);
	const tabs = useTabsStore((s) => s.tabs);
	const titles = usePaneMeta((s) => s.titleByPane);
	const contacts = usePaneMeta((s) => s.contactByPane);
	const briefs = usePaneMeta((s) => s.briefByPane);
	const sessionIdByPane = usePaneMeta((s) => s.sessionIdByPane);
	const { activeId, isLoading } = useOdinProfile();
	const sessions = useMemo(
		() =>
			isLoading
				? []
				: boardSessions(panes, new Set(tabs.map((tab) => tab.id)), activeId, {
						titles,
						contacts,
						briefs,
					}),
		[panes, tabs, activeId, isLoading, titles, contacts, briefs],
	);

	// Session History's own query, input and all, so the two share a cache.
	const transcriptQuery = useDebounced(query.trim(), 250);
	const history = electronTrpc.terminal.searchClaudeSessions.useInfiniteQuery(
		{ query: transcriptQuery, limit: 40 },
		{
			enabled: transcriptQuery.length >= 2,
			getNextPageParam: (page) => page.nextCursor ?? undefined,
		},
	);
	// History is finished work - a session still running is the board's card.
	const { data: daemonSessions } =
		electronTrpc.terminal.listDaemonSessions.useQuery(undefined, {
			refetchInterval: 5_000,
		});
	const pastSessions = useMemo(() => {
		if (transcriptQuery.length < 2) return [];
		const live = liveConversationIds(
			daemonSessions?.sessions ?? [],
			panes,
			sessionIdByPane,
		);
		const needle = normalizeQuery(transcriptQuery);
		const found: PastSession[] = history.data?.pages[0]?.sessions ?? [];
		return found
			.filter((row) => !live.has(row.sessionId))
			.map((item) => ({
				item,
				tier: matchRank(needle, item.title, [item.person]) ?? TRANSCRIPT_TIER,
			}))
			.sort((a, b) => a.tier - b.tier);
	}, [transcriptQuery, history.data, daemonSessions, panes, sessionIdByPane]);
	const isSearchingHistory =
		query.trim().length >= 2 &&
		(history.isFetching || transcriptQuery !== query.trim());

	const shown = useMemo(() => {
		const bySource = new Map<string, Ranked<PaletteRow>[]>(
			SOURCES.map(({ label }) => [label, []]),
		);
		for (const hit of rankRows(query, rows))
			bySource.get(hit.item.source)?.push(hit);
		return groupResults<Hit>(
			[
				{
					id: BOARD,
					hits: wrapHits(rankSessions(query, sessions), (session) => ({
						kind: "board",
						session,
					})),
				},
				...[...bySource].map(([id, hits]) => ({
					id,
					hits: wrapHits(hits, (row) => ({ kind: "row", row })),
				})),
				{
					id: HISTORY,
					hits: wrapHits(pastSessions, (row) => ({ kind: "history", row })),
				},
			],
			CAP,
			expanded,
		);
	}, [query, rows, sessions, pastSessions, expanded]);

	const go = (to: () => void) => {
		onClose();
		to();
	};

	const feedItems = useMemo(
		() => new Map<string, AllItem>(feedRows.map((row) => [row.key, row])),
		[feedRows],
	);
	const hitByValue = useMemo(
		() =>
			new Map(
				shown.flatMap((group) =>
					group.items.map((hit) => [hitValue(hit), hit] as const),
				),
			),
		[shown],
	);

	const goToPane = (paneId: string) =>
		go(() => {
			usePendingFocus.getState().focus(paneId);
			navigate({ to: "/board" });
		});
	const openHistory = (sessionId: string) =>
		go(() =>
			navigate({
				to: "/sessions",
				search: { q: transcriptQuery, open: sessionId },
			}),
		);
	const openRow = (row: PaletteRow) =>
		go(() =>
			row.to === "/automations"
				? navigate({ to: "/automations" })
				: navigate({ to: "/all", search: { open: row.key } }),
		);

	/** What ⌘K offers on a hit: the row buttons All shows, in its order. */
	const actionsFor = (hit: Hit): Action[] => {
		if (hit.kind === "board")
			// ponytail: no Done here - the board's Done carries undo + resume; add when asked.
			return [
				{ label: "Go to session", run: () => goToPane(hit.session.paneId) },
			];
		if (hit.kind === "history")
			return [
				{ label: "Open transcript", run: () => openHistory(hit.row.sessionId) },
			];
		const item = feedItems.get(hit.row.key);
		if (!item)
			return [{ label: "Open automations", run: () => openRow(hit.row) }];
		const livePane = livePaneFor(item);
		return [
			{ label: "Show details", run: () => openRow(hit.row) },
			...(item.url
				? [{ label: "Open ↗", run: () => go(() => openUrl(item.url ?? "")) }]
				: []),
			livePane
				? { label: "Go to session →", run: () => goToPane(livePane) }
				: { label: "Start session", run: () => go(() => void start(item)) },
			...(hit.row.done
				? []
				: [
						{ label: "Read later", run: () => go(() => markReading(item)) },
						{ label: "Done", run: () => go(() => markDone(item)) },
					]),
		];
	};

	const openMenu = () => {
		const hit = hitByValue.get(active);
		if (!hit) return;
		setMenuFor(hit);
		setActive("action:0");
	};
	const closeMenu = () => {
		if (!menuFor) return;
		setActive(hitValue(menuFor));
		setMenuFor(null);
	};

	const renderItem = (hit: Hit): ReactNode => {
		if (hit.kind === "board") {
			const { session } = hit;
			return (
				<CommandItem
					key={session.paneId}
					value={`board:${session.paneId}`}
					className={ITEM}
					onSelect={() => goToPane(session.paneId)}
				>
					<span
						className="size-1.5 shrink-0 rounded-full"
						style={{ background: PANE_STATUS[session.status].dot }}
						title={PANE_STATUS[session.status].label}
					/>
					<span className="min-w-0 flex-1 truncate">
						{emojify(session.title)}
					</span>
					<span className={cn(ROW_META, "shrink-0")}>
						{[session.contact, session.repo].filter(Boolean).join(" · ")}
					</span>
				</CommandItem>
			);
		}
		if (hit.kind === "history") {
			const { row } = hit;
			return (
				<CommandItem
					key={row.sessionId}
					value={`history:${row.sessionId}`}
					className={cn(ITEM, "flex-col items-stretch gap-0.5")}
					onSelect={() => openHistory(row.sessionId)}
				>
					<span className="flex items-center gap-2.5">
						<span className="min-w-0 flex-1 truncate">
							{emojify(row.title)}
						</span>
						<span className={cn(ROW_META, "shrink-0")}>
							{[row.person, repoLabel(row.cwd), agoLabel(row.updatedAt)]
								.filter(Boolean)
								.join(" · ")}
						</span>
					</span>
					{row.snippets[0] && (
						<span className="truncate text-[11.5px] text-muted-foreground">
							{row.snippets[0].text}
						</span>
					)}
				</CommandItem>
			);
		}
		const { row } = hit;
		const Icon = SOURCE_ICON.get(row.source);
		return (
			<CommandItem
				key={row.key}
				value={row.key}
				className={cn(ITEM, row.done && "opacity-60")}
				onSelect={() => openRow(row)}
			>
				{Icon && <Icon className="size-3 shrink-0" aria-hidden />}
				<span className="min-w-0 flex-1 truncate">{emojify(row.title)}</span>
				{row.done && (
					<span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-faint-foreground">
						done
					</span>
				)}
				{row.person && (
					<span className={cn(ROW_META, "max-w-[140px] truncate")}>
						{row.person}
					</span>
				)}
			</CommandItem>
		);
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				showCloseButton={false}
				aria-describedby={undefined}
				onEscapeKeyDown={(event) => {
					// Esc in the actions backs out to the results, not out of search.
					if (!menuFor) return;
					event.preventDefault();
					closeMenu();
				}}
				className="top-[12vh] w-[680px] max-w-[92vw] translate-y-0 gap-0 overflow-hidden rounded-[10px] border-border bg-popover p-0 shadow-[0_18px_60px_rgba(0,0,0,0.6)] sm:max-w-[92vw]"
			>
				<DialogTitle className="sr-only">Search all</DialogTitle>
				<Command
					shouldFilter={false}
					value={active}
					onValueChange={setActive}
					onKeyDown={(event) => {
						if (!isHotkey("ODIN_SEARCH_ROW_MENU", event.nativeEvent)) return;
						event.preventDefault();
						event.stopPropagation();
						if (menuFor) closeMenu();
						else openMenu();
					}}
					className="bg-transparent"
				>
					<CommandInput
						value={query}
						onValueChange={(value) => {
							setQuery(value);
							setExpanded(new Set());
							setMenuFor(null);
						}}
						placeholder="Search feeds, the board and every past session"
						className="text-[13px]"
					/>
					<CommandList className="max-h-[64vh] p-1">
						{menuFor ? (
							<CommandGroup heading={`Actions - ${emojify(hitTitle(menuFor))}`}>
								{actionsFor(menuFor).map((action, index) => (
									<CommandItem
										key={action.label}
										value={`action:${index}`}
										className={ITEM}
										onSelect={action.run}
									>
										{action.label}
									</CommandItem>
								))}
							</CommandGroup>
						) : (
							<>
								{!isSearchingHistory && (
									<CommandEmpty className="py-6 text-center text-xs text-muted-foreground">
										Nothing matches
									</CommandEmpty>
								)}
								{shown.map((group) => (
									<CommandGroup key={group.id} heading={group.id}>
										{group.items.map(renderItem)}
										{group.more > 0 && (
											<CommandItem
												value={`more:${group.id}`}
												className={cn(ITEM, "text-muted-foreground")}
												onSelect={() =>
													setExpanded((prev) => new Set(prev).add(group.id))
												}
											>
												Show {group.more} more from {group.id}
											</CommandItem>
										)}
									</CommandGroup>
								))}
								{isSearchingHistory && (
									<div className="px-2.5 py-2 text-[11px] text-muted-foreground">
										Searching session history…
									</div>
								)}
							</>
						)}
					</CommandList>
					<div className="flex justify-end gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
						{menuFor ? "Esc Back" : `${actionKeys} Actions`}
					</div>
				</Command>
			</DialogContent>
		</Dialog>
	);
}
