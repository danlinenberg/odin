/**
 * Shared notification types used by both main and renderer processes.
 * Kept in shared/ to avoid cross-boundary imports.
 */

export interface NotificationIds {
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
	sessionId?: string;
	terminalId?: string;
}

export interface AgentLifecycleEvent extends NotificationIds {
	eventType:
		| "Start"
		| "Stop"
		| "PermissionRequest"
		| "PendingQuestion"
		| "Failed";
}

/** An agent asking Odin to run `command` in its session's Shell pane. */
export interface RunInShellRequest {
	/** The agent's own pane — `$ODIN_PANE_ID` in its environment. */
	paneId: string;
	command: string;
}

export type V2NotificationSource =
	| { type: "terminal"; id: string }
	| { type: "chat"; id: string };

export interface V2NotificationSourceFocusTarget {
	workspaceId: string;
	source: V2NotificationSource;
}
