/**
 * Claude conversations that still have a card on the board - dead PTY or not.
 * A card whose shell exited is still the session: History listing it offered
 * a Resume that spawned a second pane on a conversation that card already
 * holds. Done removes the pane (or marks it completed), which is what hands
 * the conversation over to History.
 */
export function boardConversationIds(
	panes: Record<
		string,
		{ claudeSessionId?: string; completed?: boolean } | undefined
	>,
	sessionIdByPane: Record<string, string>,
): Set<string> {
	return new Set(
		Object.entries(panes)
			.filter(([, pane]) => pane && !pane.completed)
			.map(([paneId, pane]) => pane?.claudeSessionId ?? sessionIdByPane[paneId])
			.filter((id): id is string => Boolean(id)),
	);
}
