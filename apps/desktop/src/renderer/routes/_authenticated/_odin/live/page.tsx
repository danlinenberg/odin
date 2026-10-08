import { cn } from "@odin/ui/utils";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { emojify } from "renderer/lib/emoji";
import { coldRestoreState } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/state";
import { Terminal } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/Terminal";
import * as terminalCache from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache";
import { useTabsStore } from "renderer/stores/tabs/store";
import { BUTTON } from "../components/pill";
import { useActiveSessions } from "../hooks/useActiveSessions";
import { PANE_STATUS } from "../pane-status";

/**
 * Live - every running session as Superset lays out a workspace: the list on
 * the left, the selected session's real terminal on the right. Moving between
 * sessions is one click or an arrow key, with no drawer to open and close.
 */
export const Route = createFileRoute("/_authenticated/_odin/live/")({
	component: LivePage,
});

function LivePage() {
	// Needs-you first, then working, done, idle - the order the hook sorts in.
	const sessions = useActiveSessions();
	const [picked, setPicked] = useState<string | null>(null);
	// A picked session that ended falls back to the top of the list.
	const selected =
		sessions.find((session) => session.paneId === picked) ?? sessions[0];
	const pane = useTabsStore((state) =>
		selected ? state.panes[selected.paneId] : undefined,
	);
	const workspaceId = useTabsStore(
		(state) => state.tabs.find((tab) => tab.id === pane?.tabId)?.workspaceId,
	);

	// The drawer's clean mount (board openDrawer): drop the pane's parked xterm
	// and cold-restore marker before the Terminal mounts, or a killed+resumed
	// session mounts read-only and drops every keystroke.
	const [mounted, setMounted] = useState<string | null>(null);
	const selectedId = selected?.paneId ?? null;
	useEffect(() => {
		if (!selectedId) return;
		coldRestoreState.delete(selectedId);
		terminalCache.dispose(selectedId);
		setMounted(selectedId);
	}, [selectedId]);

	if (sessions.length === 0) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
				Nothing is running.
				<Link to="/board" className="text-primary hover:underline">
					Open the Dev Board
				</Link>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1">
			{/* Arrow keys only while the list has focus: in the terminal they
			    belong to Claude. */}
			<nav
				aria-label="Running sessions"
				className="flex w-64 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-2"
				onKeyDown={(event) => {
					if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
					event.preventDefault();
					const index =
						sessions.findIndex((s) => s.paneId === selectedId) +
						(event.key === "ArrowDown" ? 1 : -1);
					const next = sessions[index];
					if (!next) return;
					setPicked(next.paneId);
					event.currentTarget.querySelectorAll("button")[index]?.focus();
				}}
			>
				{sessions.map((session) => {
					const status = PANE_STATUS[session.column];
					const isSelected = session.paneId === selectedId;
					return (
						<button
							key={session.paneId}
							type="button"
							aria-current={isSelected ? "true" : undefined}
							onClick={() => setPicked(session.paneId)}
							className={cn(
								"flex flex-col gap-0.5 rounded-[7px] px-2.5 py-1.5 text-left",
								isSelected
									? BUTTON.selected
									: "text-muted-foreground hover:bg-accent hover:text-foreground",
							)}
						>
							<span className="flex items-center gap-2 text-[13px] font-semibold">
								<span
									className={cn(
										"size-1.5 shrink-0 rounded-full",
										session.column === "working" && "animate-pulse",
									)}
									style={{ background: status.dot }}
								/>
								<span className="truncate">{emojify(session.title)}</span>
							</span>
							<span className="truncate pl-3.5 text-[11px] text-faint-foreground">
								{status.label}
								{session.repo && ` · ${session.repo}`}
							</span>
						</button>
					);
				})}
			</nav>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background p-2">
				{/* ponytail: the agent-gone case (Claude exited, PTY still alive)
				    shows that live shell rather than the board's "Session closed". */}
				{pane && workspaceId && mounted === pane.id && (
					<Terminal
						key={pane.id}
						paneId={pane.id}
						tabId={pane.tabId}
						workspaceId={workspaceId}
					/>
				)}
			</div>
		</div>
	);
}
