/** What a session restarted for a connector's lost sign-in opens with. */
export const MCP_SIGNED_IN_RETRY =
	"A connector lost its sign-in, so Odin restarted this session to load it again. Retry what failed: carry on with my last message.";

/**
 * Whether a session whose turn just ended should restart because one of its
 * Claude Code connectors (MCP servers) lost its sign-in during that turn: a
 * session loads its connectors' sign-ins when it starts, so a restart picks
 * up one renewed since. Once per turn - a retry that fails the same way is
 * left for you. Returns the key that marks this restart done, or null.
 */
export function mcpRestartKey(
	paneId: string,
	signedOut: { at: string | null } | null | undefined,
	messages: { role: string; text: string; at: string | null }[],
): string | null {
	if (!signedOut?.at) return null;
	const lastUser = messages.findLast((m) => m.role === "user");
	if (lastUser?.text.trim() === MCP_SIGNED_IN_RETRY) return null;
	// The failure came before your latest message: a turn since went through.
	if (lastUser?.at && Date.parse(lastUser.at) > Date.parse(signedOut.at))
		return null;
	return `${paneId}:${signedOut.at}`;
}
