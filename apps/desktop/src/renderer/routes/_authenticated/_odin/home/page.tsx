import { Tooltip, TooltipContent, TooltipTrigger } from "@odin/ui/tooltip";
import { cn } from "@odin/ui/utils";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	type CSSProperties,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	HiOutlineArrowsPointingOut,
	HiOutlineChatBubbleLeftRight,
} from "react-icons/hi2";
import { emojify } from "renderer/lib/emoji";
import { runWhenParserIdle } from "renderer/lib/terminal/parser-idle-gate";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { coldRestoreState } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/state";
import { Terminal } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/Terminal";
import * as terminalCache from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache";
import { useHomeOrder } from "renderer/stores/home-order";
import { useInAppBrowser } from "renderer/stores/in-app-browser";
import { useSessionView } from "renderer/stores/session-view";
import { useTabsStore } from "renderer/stores/tabs/store";
import { profileOf } from "shared/odin-profile";
import { ChatView } from "../board/ChatView";
import { interruptPane } from "../board/interrupt";
import { NewSessionDialog } from "../components/NewSessionDialog";
import { untruncatedTitle } from "../components/OdinPromptDialog";
import { BUTTON } from "../components/pill";
import { useBoardColumns } from "../hooks/useBoardColumns";
import { useOdinProfile } from "../hooks/useOdinProfile";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { PANE_STATUS } from "../pane-status";
import {
	type HomeCard,
	homeCards,
	homeGrid,
	homeOrder,
	moveCard,
} from "./home-cards";

/**
 * Home - every session that's working or waiting on you, side by side and
 * live, so you can watch them all and answer one without opening it. Each
 * card shows its session the way the board's drawer does: as a chat, or as
 * its terminal (Settings > Appearance).
 */
export const Route = createFileRoute("/_authenticated/_odin/home/")({
	component: HomePage,
});

/** What a dragged card carries - not text, so no terminal or box takes it. */
const CARD_DRAG = "application/x-odin-home-card";

/** A PTY nobody has attached to runs at the daemon's launch size. */
const LAUNCH_SIZE = { cols: 80, rows: 24 };

/**
 * The session's terminal, fitted to its card - which resizes the PTY with it.
 * On the way out, the parked xterm and the PTY go back to the size they had
 * before Home, so a session nobody is looking at isn't left drawing Claude
 * Code at card width for the board's screen reads. The drawer refits on open
 * either way.
 */
function CardTerminal({
	paneId,
	tabId,
	workspaceId,
	focused,
}: {
	paneId: string;
	tabId: string;
	workspaceId: string;
	focused: boolean;
}) {
	// A layout effect, so it runs before the Terminal below attaches and fits.
	useLayoutEffect(() => {
		const parked = terminalCache.get(paneId);
		const before = parked
			? { cols: parked.xterm.cols, rows: parked.xterm.rows }
			: LAUNCH_SIZE;
		// The same clean mount the board's openDrawer does: a parked xterm left
		// by a resumed or cold-restored session drops every keystroke.
		if (parked && !parked.container) {
			coldRestoreState.delete(paneId);
			terminalCache.dispose(paneId);
		}
		return () => {
			// After the Terminal's own unmount has parked its xterm. Something
			// that attached it since (the drawer) owns the size now.
			setTimeout(() => {
				const entry = terminalCache.get(paneId);
				if (!entry || entry.container) return;
				runWhenParserIdle(entry.gate, () => {
					if (terminalCache.get(paneId) !== entry || entry.container) return;
					entry.xterm.resize(before.cols, before.rows);
					electronTrpcClient.terminal.resize
						.mutate({ paneId, ...before })
						.catch(() => {});
				});
			});
		};
	}, [paneId]);
	return (
		<Terminal
			paneId={paneId}
			tabId={tabId}
			workspaceId={workspaceId}
			focused={focused}
		/>
	);
}

/** Quiet until hovered: the header is the card's frame, not a toolbar. */
const ICON_BUTTON =
	"flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60";

/** A header icon, its words in a tooltip. */
function HeaderIcon({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<Tooltip delayDuration={300}>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

function HomePage() {
	const navigate = useNavigate();
	const tabs = useTabsStore((state) => state.tabs);
	const panes = useTabsStore((state) => state.panes);
	const titleByPane = usePaneMeta((s) => s.titleByPane);
	const briefByPane = usePaneMeta((s) => s.briefByPane);
	const sessionIdByPane = usePaneMeta((s) => s.sessionIdByPane);
	const chatView = useSessionView((s) => s.chat);
	const setChatView = useSessionView((s) => s.setChat);
	// The cards answering a menu in their terminal, like the drawer's
	// terminalPaneId: the chat can't answer a TUI menu.
	const [terminalPaneIds, setTerminalPaneIds] = useState<string[]>([]);
	const { activeId: activeProfileId, isLoading: isProfileLoading } =
		useOdinProfile();
	const { daemonSessions, agentPaneIds, columnOf } = useBoardColumns({
		panes,
		tabs,
		titleByPane,
		activeProfileId,
	});

	const workspaceByTab = useMemo(
		() => new Map(tabs.map((tab) => [tab.id, tab.workspaceId])),
		[tabs],
	);
	// The board's own cards: terminals Odin launched, under this profile.
	const cards = useMemo(
		() =>
			homeCards(
				Object.values(panes).filter(
					(pane) =>
						pane.type === "terminal" &&
						!!(pane.odinTaskTitle || titleByPane[pane.id]) &&
						profileOf(pane.odinProfile) === activeProfileId &&
						workspaceByTab.has(pane.tabId),
				),
				columnOf,
				agentPaneIds,
			),
		[
			panes,
			titleByPane,
			activeProfileId,
			workspaceByTab,
			columnOf,
			agentPaneIds,
		],
	);
	// Where each card sits: the order they arrived in, or where you dragged
	// them. Never by status, so nothing moves under you.
	const savedOrder = useHomeOrder((s) => s.byProfile[activeProfileId]);
	const setOrder = useHomeOrder((s) => s.setOrder);
	const presentKey = cards.map((card) => card.pane.id).join(",");
	const order = useMemo(
		() => homeOrder(savedOrder ?? [], presentKey ? presentKey.split(",") : []),
		[savedOrder, presentKey],
	);
	const ready = daemonSessions !== undefined && !isProfileLoading;
	// Save what's on Home now, so a card that left drops out and comes back
	// at the end. Not before the first poll: everything reads as gone then.
	useEffect(() => {
		if (ready && order.join(",") !== (savedOrder ?? []).join(","))
			setOrder(activeProfileId, order);
	}, [ready, order, savedOrder, setOrder, activeProfileId]);
	const [isNewSessionOpen, setIsNewSessionOpen] = useState(false);
	const [dragId, setDragId] = useState<string | null>(null);
	const [dropId, setDropId] = useState<string | null>(null);

	const rootRef = useRef<HTMLDivElement>(null);
	const [focusedId, setFocusedId] = useState<string | null>(null);
	// A focused card that left Home (finished, went idle) leaves nothing focused,
	// and doesn't take the keyboard back if it returns.
	const focused = cards.some((card) => card.pane.id === focusedId)
		? focusedId
		: null;
	useEffect(() => {
		if (focusedId && !focused) setFocusedId(null);
	}, [focusedId, focused]);
	const clearFocus = useCallback(() => {
		setFocusedId(null);
		const active = document.activeElement;
		if (active instanceof HTMLElement && rootRef.current?.contains(active))
			active.blur();
	}, []);

	// Esc in a terminal is Claude's; anywhere else on Home it lets go.
	useEffect(() => {
		if (!focused) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			if (useInAppBrowser.getState().url) return;
			const target = event.target as HTMLElement | null;
			if (target?.closest(".xterm, [role=dialog]")) return;
			clearFocus();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [focused, clearFocus]);

	// Nothing to say until the first poll: every session would read as dead.
	if (!ready) return null;

	const header = (
		<div className="flex shrink-0 items-center gap-3 px-[18px] pb-2 pt-2.5">
			<h1 className="text-[15px] font-semibold">Home</h1>
			<button
				type="button"
				title="Describe a task and start an agent session"
				onClick={() => setIsNewSessionOpen(true)}
				className={cn(
					"rounded-lg px-2.5 py-1 text-[12px] font-semibold transition-colors",
					BUTTON.primary,
				)}
			>
				+ New Session
			</button>
			{isNewSessionOpen && (
				<NewSessionDialog onClose={() => setIsNewSessionOpen(false)} />
			)}
		</div>
	);

	if (cards.length === 0) {
		return (
			<div className="flex h-full flex-col">
				{header}
				<div className="flex flex-1 items-center justify-center gap-1 text-[13px] text-muted-foreground">
					Nothing is running.
					<Link to="/board" className="underline hover:text-foreground">
						Open the Dev Board
					</Link>
				</div>
			</div>
		);
	}

	const { cols, rows } = homeGrid(cards.length);
	const title = ({ pane }: HomeCard) =>
		emojify(
			untruncatedTitle(
				pane.odinTaskTitle ??
					titleByPane[pane.id] ??
					pane.userTitle ??
					pane.name,
				pane.odinBrief ?? briefByPane[pane.id] ?? null,
			),
		);
	// Rendered in a fixed order and placed with `order`: a card that moves -
	// dragged, or another one arriving or leaving - never has its DOM node
	// moved, which would remount it or blur the terminal you're typing in.
	const stable = [...cards].sort((a, b) => a.pane.id.localeCompare(b.pane.id));

	return (
		<div ref={rootRef} className="flex h-full flex-col">
			{header}
			{/* A size container, so a row can be a fraction of the visible height:
			    the first `rows` rows fill the screen, the rest scroll below. */}
			<div
				className="min-h-0 flex-1 overflow-y-auto"
				style={{ containerType: "size" }}
			>
				<div
					className="grid gap-3 px-[18px] pb-[18px] pt-1"
					style={{
						gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
						gridAutoRows: `calc((100cqh - 22px - ${(rows - 1) * 12}px) / ${rows})`,
					}}
				>
					{stable.map((card) => {
						const { pane, column } = card;
						const isFocused = focused === pane.id;
						const workspaceId = workspaceByTab.get(pane.tabId) ?? "";
						const showsTerminal =
							!chatView || terminalPaneIds.includes(pane.id);
						return (
							<section
								key={pane.id}
								aria-label={title(card)}
								style={{ order: order.indexOf(pane.id) }}
								onDragOver={(event) => {
									if (!dragId || !event.dataTransfer.types.includes(CARD_DRAG))
										return;
									event.preventDefault();
									event.dataTransfer.dropEffect = "move";
									if (dropId !== pane.id) setDropId(pane.id);
								}}
								onDragLeave={(event) => {
									if (
										!event.currentTarget.contains(event.relatedTarget as Node)
									)
										setDropId(null);
								}}
								onDrop={(event) => {
									if (!dragId || !event.dataTransfer.types.includes(CARD_DRAG))
										return;
									event.preventDefault();
									setOrder(activeProfileId, moveCard(order, dragId, pane.id));
									setDragId(null);
									setDropId(null);
								}}
								className={cn(
									"flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-card transition-opacity duration-150",
									isFocused || dropId === pane.id
										? "border-primary/50"
										: "border-border",
									dragId === pane.id
										? "opacity-40"
										: focused && !isFocused && "opacity-[0.55]",
								)}
							>
								{/* The header is the drag handle - the body is for reading and typing. */}
								{/* biome-ignore lint/a11y/noStaticElementInteractions: drag is the mouse-only shortcut for reordering; the buttons inside stay keyboard-reachable */}
								<div
									draggable
									onDragStart={(event) => {
										event.dataTransfer.setData(CARD_DRAG, pane.id);
										event.dataTransfer.effectAllowed = "move";
										setDragId(pane.id);
									}}
									onDragEnd={() => {
										setDragId(null);
										setDropId(null);
									}}
									className="flex h-8 shrink-0 cursor-grab items-center gap-0.5 border-b border-border pr-1 pl-3 active:cursor-grabbing"
								>
									<button
										type="button"
										title={isFocused ? "Unfocus" : "Focus this session"}
										onClick={() =>
											isFocused ? clearFocus() : setFocusedId(pane.id)
										}
										className="min-w-0 flex-1 truncate rounded-sm text-left text-[12.5px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
									>
										{title(card)}
									</button>
									<HeaderIcon label={PANE_STATUS[column].label}>
										{/* The board's column dot, in the column's colour. */}
										<span
											role="img"
											aria-label={PANE_STATUS[column].label}
											className="flex size-6 shrink-0 items-center justify-center"
											style={
												{ "--col": PANE_STATUS[column].dot } as CSSProperties
											}
										>
											<span
												className={cn(
													"size-2 rounded-full bg-(--col) shadow-[0_0_8px_var(--col)]",
													column === "working" && "animate-pulse",
												)}
											/>
										</span>
									</HeaderIcon>
									{showsTerminal && agentPaneIds.has(pane.id) && (
										<HeaderIcon label="Show as a chat (Settings > Appearance)">
											<button
												type="button"
												aria-label="Show as a chat"
												onClick={() =>
													chatView
														? setTerminalPaneIds((ids) =>
																ids.filter((id) => id !== pane.id),
															)
														: setChatView(true)
												}
												className={ICON_BUTTON}
											>
												<HiOutlineChatBubbleLeftRight className="size-3.5" />
											</button>
										</HeaderIcon>
									)}
									<HeaderIcon label="Open on the Dev Board">
										<button
											type="button"
											aria-label="Open on the Dev Board"
											onClick={() => {
												usePendingFocus.getState().focus(pane.id);
												navigate({ to: "/board" });
											}}
											className={ICON_BUTTON}
										>
											<HiOutlineArrowsPointingOut className="size-3.5" />
										</button>
									</HeaderIcon>
								</div>
								{/* Clicking or tabbing into the body makes this the focused card. */}
								<div
									className="flex min-h-0 flex-1 flex-col"
									onPointerDownCapture={() => setFocusedId(pane.id)}
									onFocusCapture={() => setFocusedId(pane.id)}
								>
									{!agentPaneIds.has(pane.id) ? (
										// No Claude to attach to (closed for sitting idle, or
										// only a shell left): the drawer's history and Resume.
										<div className="flex flex-1 items-center justify-center px-4 text-center text-[12px] text-muted-foreground">
											Session closed - open it on the Dev Board to resume.
										</div>
									) : showsTerminal ? (
										<div className="min-h-0 flex-1">
											<CardTerminal
												paneId={pane.id}
												tabId={pane.tabId}
												workspaceId={workspaceId}
												focused={isFocused}
											/>
										</div>
									) : (
										<ChatView
											paneId={pane.id}
											sessionId={
												pane.claudeSessionId ?? sessionIdByPane[pane.id] ?? null
											}
											cwd={pane.cwd ?? pane.initialCwd ?? pane.odinCwd}
											workspaceId={workspaceId}
											working={pane.status === "working"}
											onShowTerminal={() =>
												setTerminalPaneIds((ids) => [...ids, pane.id])
											}
											onStop={() => interruptPane(pane.id)}
											focusComposer={isFocused}
											density="compact"
										/>
									)}
								</div>
							</section>
						);
					})}
				</div>
			</div>
		</div>
	);
}
