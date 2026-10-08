import { cn } from "@odin/ui/utils";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { emojify } from "renderer/lib/emoji";
import { runWhenParserIdle } from "renderer/lib/terminal/parser-idle-gate";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { coldRestoreState } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/state";
import { Terminal } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/Terminal";
import * as terminalCache from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache";
import { useInAppBrowser } from "renderer/stores/in-app-browser";
import { useTabsStore } from "renderer/stores/tabs/store";
import { profileOf } from "shared/odin-profile";
import { untruncatedTitle } from "../components/OdinPromptDialog";
import { BUTTON, PILL } from "../components/pill";
import { useOdinProfile } from "../hooks/useOdinProfile";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { PANE_STATUS } from "../pane-status";
import { type HomeCard, homeCards, homeGrid } from "./home-cards";

/**
 * Home - the live terminal of every session that's working or waiting on you,
 * side by side, so you can watch them all and answer one without opening it.
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

function HomePage() {
	const navigate = useNavigate();
	const tabs = useTabsStore((state) => state.tabs);
	const panes = useTabsStore((state) => state.panes);
	const titleByPane = usePaneMeta((s) => s.titleByPane);
	const briefByPane = usePaneMeta((s) => s.briefByPane);
	const { activeId: activeProfileId, isLoading: isProfileLoading } =
		useOdinProfile();
	const { data: daemonSessions } =
		electronTrpc.terminal.listDaemonSessions.useQuery(undefined, {
			refetchInterval: 5_000,
		});

	const workspaceByTab = useMemo(
		() => new Map(tabs.map((tab) => [tab.id, tab.workspaceId])),
		[tabs],
	);
	const alive = useMemo(
		() =>
			new Set(
				(daemonSessions?.sessions ?? [])
					.filter((session) => session.isAlive)
					.map((session) => session.sessionId),
			),
		[daemonSessions],
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
				alive,
			),
		[panes, titleByPane, activeProfileId, workspaceByTab, alive],
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
					return (
						<section
							key={pane.id}
							aria-label={title(card)}
							style={{ order: cards.indexOf(card) }}
							// Clicking into a terminal focuses it natively; this makes it
							// the focused card too.
							onFocusCapture={(event) => {
								if (
									(event.target as HTMLElement).classList.contains(
										"xterm-helper-textarea",
									)
								)
									setFocusedId(pane.id);
							}}
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
								<span
									className={cn(
										"shrink-0 rounded-full px-2 py-[2px] text-[11px] font-semibold",
										column === "working" ? PILL.working : PILL.attention,
									)}
								>
									{PANE_STATUS[column].label}
								</span>
								<button
									type="button"
									title="Open this session on the Dev Board"
									onClick={() => {
										usePendingFocus.getState().focus(pane.id);
										navigate({ to: "/board" });
									}}
									className={cn(
										"shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold",
										BUTTON.secondary,
									)}
								>
									Open
								</button>
							</div>
							<div className="min-h-0 flex-1 bg-background">
								{alive.has(pane.id) ? (
									<CardTerminal
										paneId={pane.id}
										tabId={pane.tabId}
										workspaceId={workspaceId}
										focused={isFocused}
									/>
								) : (
									// Closed for sitting idle: attaching would start a bare
									// shell in its place. The drawer resumes it.
									<div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
										Session closed - Open it to resume.
									</div>
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
