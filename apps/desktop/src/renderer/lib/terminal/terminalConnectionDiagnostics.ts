export type TerminalFailureCategory =
	/** The socket kept failing to (re)connect. */
	| "connection-lost"
	/** The host service answered with an error and closed. */
	| "server-error"
	/** The PTY exited. */
	| "session-ended";

export interface TerminalFailureClassification {
	category: TerminalFailureCategory;
	/** Short, user-facing reason for the terminal not connecting. */
	message: string;
}

/**
 * The host service runs on loopback, so a dropped stream has no remote cause
 * to tell apart — the diagnosis is the fact itself. It's a value rather than a
 * bare string so the pane header can distinguish "diagnosed an outage" from
 * "healthy".
 */
export const TERMINAL_CONNECTION_LOST: TerminalFailureClassification = {
	category: "connection-lost",
	message: "The terminal connection was lost.",
};
