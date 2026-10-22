type Message = { text: string; paths: string[] };

/**
 * What to type into a session. One running on the remote host can't read this
 * computer's files (the phone's uploads sit in ~/.odin/attachments here), so they
 * go to the host first and the session gets the copies' paths, as the board's
 * composer does. A local session gets its message as it is.
 *
 * `toHost` failing (the host is down) fails the reply: typing a path the
 * session can't open would look sent and do nothing.
 */
export async function forSession(
	pane: { odinRemote?: string } | undefined,
	message: Message,
	toHost: (message: Message) => Promise<Message>,
): Promise<Message> {
	if (!pane?.odinRemote || !message.paths.length) return message;
	return toHost(message);
}
