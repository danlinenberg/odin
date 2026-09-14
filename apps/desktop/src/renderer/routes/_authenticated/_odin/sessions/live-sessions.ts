/**
 * Claude conversations whose PTY is still alive in the daemon. A daemon
 * session id IS a paneId; the pane carries the conversation it launched
 * (older panes only made the usePaneMeta mirror).
 */
export function liveConversationIds(
	daemonSessions: { sessionId: string; isAlive: boolean }[],
	panes: Record<string, { claudeSessionId?: string } | undefined>,
	sessionIdByPane: Record<string, string>,
): Set<string> {
	return new Set(
		daemonSessions
			.filter((session) => session.isAlive)
			.map(
				(session) =>
					panes[session.sessionId]?.claudeSessionId ??
					sessionIdByPane[session.sessionId],
			)
			.filter((id): id is string => Boolean(id)),
	);
}
