/** The host's tmux session for a session (Claude's session id). */
export const tmuxSession = (pane: string) =>
	`odin-${pane.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60)}`;

/** A board card whose remote PTY died, as the reconnect pick sees it. */
export interface DeadRemoteCard {
	paneId: string;
	/** The card's `odinRemote`: the host it runs on. */
	host: string;
	sessionId: string;
}

/**
 * The dead remote cards whose Claude is still running in tmux on the host:
 * the ones a reattach brings back as they were. A host missing from `live`
 * (not asked yet, or unreachable) reconnects nothing, and neither does a card
 * whose tmux session ended there.
 */
export function remoteCardsToReconnect<T extends DeadRemoteCard>(
	cards: T[],
	live: Record<string, readonly string[] | null | undefined>,
): T[] {
	return cards.filter((card) =>
		live[card.host]?.includes(tmuxSession(card.sessionId)),
	);
}
