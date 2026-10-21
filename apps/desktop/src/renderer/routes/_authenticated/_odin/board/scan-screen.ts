/**
 * The screen the board's status scan reads for a live session.
 *
 * The scan used to attach to every pane it read. createOrAttach answers with
 * the pane's whole scrollback - 5000 lines serialized with their colours,
 * near a megabyte for a long session - and on the way main rewrites the
 * pane's history file with it. Every 5 seconds, for every session whose
 * hooks had gone quiet: every one sitting at its prompt, and every remote
 * one whose hooks the host could not deliver. Twenty of those were four full
 * snapshots a second on the daemon's one thread and through the one socket
 * every live terminal shares, and Odin crawled while the host ran the work.
 *
 * The visible screen is all the scan classifies, so that is what it reads:
 * readScreen is the daemon copying its rows out - no attach, no history
 * rewrite, a few kilobytes. One attach per pane per run stays, on the first
 * read: after a restart it is what puts main back on a pane's output stream,
 * so the pane's history keeps being written.
 */
export async function scanScreen(
	paneId: string,
	/** Panes this run has attached to - a renderer reload starts over, as before. */
	attached: Set<string>,
	read: {
		/** The mounted xterm's screen; "" when the pane isn't on screen. */
		visible: string;
		/** The daemon's copy of the screen; null when it can't say. */
		screen: () => Promise<string | null>;
		/** Attach, and the snapshot's tail as plain text. */
		attach: () => Promise<string>;
	},
): Promise<string> {
	if (!attached.has(paneId)) {
		const screen = await read.attach();
		attached.add(paneId);
		return screen;
	}
	if (read.visible) return read.visible;
	return (await read.screen()) ?? (await read.attach());
}
