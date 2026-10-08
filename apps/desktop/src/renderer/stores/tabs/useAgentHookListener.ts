import { useNavigate } from "@tanstack/react-router";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { usePendingFocus } from "renderer/routes/_authenticated/_odin/hooks/usePendingFocus";
import { useCompacting } from "renderer/stores/compacting";
import { NOTIFICATION_EVENTS } from "shared/constants";
import { debugLog } from "shared/debug";
import type { PaneStatus } from "shared/tabs-types";
import { useTabsStore } from "./store";
import { resolveNotificationTarget } from "./utils/resolve-notification-target";

/**
 * Hook that listens for agent lifecycle events via tRPC subscription and updates
 * pane status indicators accordingly.
 *
 * STATUS MAPPING:
 * - Start → "working" (amber pulsing indicator)
 * - Compacting (PreCompact) → "working", and the chat view says "Compacting"
 * - Stop → "review" (green static) if pane's tab not active, "idle" if tab is active
 * - Failed (StopFailure) → "failed" (red) - the turn died on an API error
 * - PermissionRequest → "permission" (red pulsing indicator)
 * - Terminal Exit → "idle" (handled in Terminal.tsx when mounted; also forwarded via notifications for unmounted panes)
 *
 * KNOWN LIMITATIONS (External - Claude Code / OpenCode hook systems):
 *
 * 1. User Interrupt (Ctrl+C): Claude Code's Stop hook does NOT fire when the user
 *    interrupts the agent. However, the terminal exit handler in Terminal.tsx
 *    will automatically clear the "working" indicator when the process exits.
 *
 * 2. Permission Denied: No hook fires when the user denies a permission request.
 *    The terminal exit handler will clear the "permission" indicator on process exit.
 *
 * 3. Tool Failures: No hook fires when a tool execution fails. The status
 *    continues until the agent stops or terminal exits.
 *
 * Note: Terminal exit detection (in Terminal.tsx) provides a reliable fallback
 * for clearing stuck indicators when agent hooks fail to fire.
 */

/**
 * Returns the current workspace ID from the live URL hash.
 * The app uses hash routing: file:///.../index.html#/workspace/<id>
 * We must read window.location.hash (not pathname) at event time since the
 * _authenticated layout does not re-render on workspace navigation.
 */
function getCurrentWorkspaceId(): string | null {
	try {
		const match = window.location.hash.match(/\/workspace\/([^/?#]+)/);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}

/**
 * When each pane last heard from its agent hooks, whatever they said.
 *
 * `setPaneStatus` no-ops on an unchanged value, so a pane mid-turn - where
 * every few seconds another hook repeats "working" - looks frozen to anything
 * measuring how long a status has held. The board's screen-reading repair scan
 * was measuring exactly that, so it read live screens all turn long and one
 * bad read was enough to flip the card to Needs you. What it actually wants is
 * "have the hooks gone quiet", which is this.
 */
export const lastAgentHookAt = new Map<string, number>();

/**
 * Where a card lands when the agent's turn ends: Done ("review") unless you
 * watched it end, or you were already engaged with it (a permission prompt you
 * answered - that turn's end is not news).
 */
export function stopStatus(
	paneStatus: PaneStatus | undefined,
	watched: boolean,
): PaneStatus {
	if (paneStatus === "permission") return "idle";
	return watched ? "idle" : "review";
}

/**
 * `command`, then a shell to come back to. Ctrl+C has to stop the command, not
 * the pane: the trap keeps `zsh -c` alive through it (the command itself still
 * gets the default SIGINT), and then it hands over to a login shell.
 */
const thenShell = (command: string) =>
	`trap : INT; ${command}\ntrap - INT; exec "\${SHELL:-/bin/zsh}" -l`;

/**
 * Run an agent's `command` in its session's Shell - the pane the drawer's
 * ❯ Shell button opens - where you can watch it and stop it.
 *
 * Always a fresh pane whose process is the command: typed into a cold shell
 * it gets swallowed, and typed into a busy one it goes to whatever is running.
 * Asking to run something there again means replacing what's there, so the
 * session's previous shell goes.
 */
async function runInSessionShell(
	sessionPaneId: string,
	workspaceId: string,
	command: string,
) {
	const state = useTabsStore.getState();
	const session = state.panes[sessionPaneId];
	if (!session) return;
	const previous = session.odinShellPaneId;
	if (previous && state.panes[previous]) state.removePane(previous);
	const cwd = session.cwd ?? session.initialCwd ?? undefined;
	const { tabId, paneId } = state.addTab(workspaceId, { initialCwd: cwd });
	useTabsStore.setState((s) => ({
		panes: {
			...s.panes,
			[sessionPaneId]: { ...s.panes[sessionPaneId], odinShellPaneId: paneId },
			[paneId]: { ...s.panes[paneId], odinAgentRun: true },
		},
	}));
	await electronTrpcClient.terminal.createOrAttach.mutate({
		paneId,
		tabId,
		workspaceId,
		cwd,
		command: thenShell(command),
	});
}

export function useAgentHookListener() {
	const navigate = useNavigate();

	electronTrpc.notifications.subscribe.useSubscription(undefined, {
		onData: (event) => {
			if (!event.data) return;
			// The crow's Odin actions are answered by useCrow.
			if (
				event.type === NOTIFICATION_EVENTS.FOCUS_V2_NOTIFICATION_SOURCE ||
				event.type === NOTIFICATION_EVENTS.ODIN_ACTION
			) {
				return;
			}

			const state = useTabsStore.getState();
			const target = resolveNotificationTarget(event.data, state);
			if (!target) return;

			const { paneId, workspaceId } = target;

			if (event.type === NOTIFICATION_EVENTS.AGENT_LIFECYCLE) {
				if (!paneId) return;
				lastAgentHookAt.set(paneId, Date.now());

				const lifecycleEvent = event.data;
				if (!lifecycleEvent) return;

				const { eventType } = lifecycleEvent;
				useCompacting
					.getState()
					.mark(paneId, eventType === "Compacting" ? Date.now() : null);

				if (eventType === "Start" || eventType === "Compacting") {
					state.setPaneStatus(paneId, "working");
				} else if (
					eventType === "PermissionRequest" ||
					eventType === "PendingQuestion"
				) {
					state.setPaneStatus(paneId, "permission");
				} else if (eventType === "Failed") {
					state.setPaneStatus(paneId, "failed");
				} else if (eventType === "Stop") {
					const activeTabId = state.activeTabIds[workspaceId];
					const pane = state.panes[paneId];
					const tabId = pane?.tabId;
					// Tab must be active for this workspace
					const isTabActive = tabId != null && tabId === activeTabId;
					// Odin fork: "you watched this turn end" has to mean the URL names
					// the workspace. Every tab is created active with its pane focused,
					// so a `focusedPaneIds` fallback is true for every session forever -
					// which sent the workspace's newest session to Idle when it finished
					// instead of Done, and the newest session is the one you just
					// launched and are waiting on.
					const isInActiveTab =
						isTabActive && getCurrentWorkspaceId() === workspaceId;

					const nextStatus = stopStatus(pane?.status, isInActiveTab);

					debugLog("agent-hooks", "Stop event:", {
						isInActiveTab,
						activeTabId,
						paneTabId: pane?.tabId,
						paneId,
						paneStatus: pane?.status,
						willSetTo: nextStatus,
					});

					state.setPaneStatus(paneId, nextStatus);
				}
			} else if (event.type === NOTIFICATION_EVENTS.TERMINAL_EXIT) {
				// Clear transient status for unmounted panes (mounted panes handle this via stream subscription)
				if (!paneId) return;
				const currentPane = state.panes[paneId];
				if (
					currentPane?.status === "working" ||
					currentPane?.status === "permission"
				) {
					state.setPaneStatus(paneId, "idle");
				}
			} else if (event.type === NOTIFICATION_EVENTS.RUN_IN_SHELL) {
				if (paneId)
					runInSessionShell(paneId, workspaceId, event.data.command).catch(
						(error) => console.warn("[run-in-shell] failed:", error),
					);
			} else if (event.type === NOTIFICATION_EVENTS.FOCUS_TAB) {
				// A banner names a board card, so clicking it opens that card's
				// session drawer. The board is where every session lives now.
				if (paneId) {
					usePendingFocus.getState().focus(paneId);
				}
				void navigate({ to: "/board" });
			}
		},
	});
}
