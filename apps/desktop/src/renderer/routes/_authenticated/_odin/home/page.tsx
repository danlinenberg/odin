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
import { useInAppBrowser } from "renderer/stores/in-app-browser";
import { useSessionView } from "renderer/stores/session-view";
import { useTabsStore } from "renderer/stores/tabs/store";
import { profileOf } from "shared/odin-profile";
import { ChatView } from "../board/ChatView";
import { interruptPane } from "../board/interrupt";
import { untruncatedTitle } from "../components/OdinPromptDialog";
import { BUTTON } from "../components/pill";
import { useBoardColumns } from "../hooks/useBoardColumns";
import { useOdinProfile } from "../hooks/useOdinProfile";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { PANE_STATUS } from "../pane-status";
import { type HomeCard, homeCards, homeGrid } from "./home-cards";

/**
 * Home - every session that's working or waiting on you, side by side and
 * live, so you can watch them all and answer one without opening it. Each
 * card shows its session the way the board's drawer does: as a chat, or as
 * its terminal (Settings > Appearance).
 */
export const Route = createFileRoute("/_authenticated/_odin/home/")({
	component: HomePage,
});

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

const ICON_BUTTON = cn(
	"flex size-6 shrink-0 items-center justify-center rounded-md",
	BUTTON.secondary,
);

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
	const { cards, more } = useMemo(
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
	if (daemonSessions === undefined || isProfileLoading) return null;

	if (cards.length === 0) {
		return (
			<div className="flex h-full items-center justify-center gap-1 text-[13px] text-muted-foreground">
				Nothing is running.
				<Link to="/board" className="underline hover:text-foreground">
					Open the Dev Board
				</Link>
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
	// Rendered in a fixed order and placed with `order`: a card that changes
	// column moves on screen without React moving its DOM node, which would
	// blur the terminal you're typing in.
	const stable = [...cards].sort((a, b) => a.pane.id.localeCompare(b.pane.id));

	return (
		<div ref={rootRef} className="flex h-full flex-col gap-2 p-[18px]">
			<div
				className="grid min-h-0 flex-1 gap-3"
				style={{
					gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
					gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
				}}
			>
				{stable.map((card) => {
					const { pane, column } = card;
					const isFocused = focused === pane.id;
					const workspaceId = workspaceByTab.get(pane.tabId) ?? "";
					const showsTerminal = !chatView || terminalPaneIds.includes(pane.id);
					return (
						<section
							key={pane.id}
							aria-label={title(card)}
							style={{ order: cards.indexOf(card) }}
							className={cn(
								"flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-tertiary/85 transition-opacity",
								isFocused ? "border-primary/50" : "border-border",
								focused && !isFocused && "opacity-[0.55]",
							)}
						>
							<div className="flex items-center gap-2 border-b border-border px-3 py-2">
								<button
									type="button"
									title={isFocused ? "Unfocus" : "Focus this session"}
									onClick={() =>
										isFocused ? clearFocus() : setFocusedId(pane.id)
									}
									className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold text-foreground"
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
								className="flex min-h-0 flex-1 flex-col bg-background"
								onPointerDownCapture={() => setFocusedId(pane.id)}
								onFocusCapture={() => setFocusedId(pane.id)}
							>
								{!agentPaneIds.has(pane.id) ? (
									// No Claude to attach to (closed for sitting idle, or
									// only a shell left): the drawer's history and Resume.
									<div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
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
									/>
								)}
							</div>
						</section>
					);
				})}
			</div>
			{more > 0 && (
				<Link
					to="/board"
					className="self-end text-xs text-muted-foreground hover:text-foreground hover:underline"
				>
					+{more} more on the Dev Board
				</Link>
			)}
		</div>
	);
}
