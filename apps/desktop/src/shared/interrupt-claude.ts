import { inputBoxRows, odinScreenStatus } from "./odin-screen-status";

/**
 * Stops Claude's turn with Ctrl+C. Not Esc: with a message queued, Esc only
 * pulls the queue back into Claude's input box and the turn runs on. And not
 * when Claude already sits at its prompt - a hook can leave the card on
 * Working - because there Ctrl+C stops every background agent the session
 * runs, and a second one quits Claude. Two reads must agree it's idle: a
 * snapshot caught mid-repaint can lack the spinner. Returns whether it sent it.
 */
export async function interruptClaude(
	write: (input: { paneId: string; data: string }) => Promise<unknown>,
	readScreen: (input: { paneId: string }) => Promise<{ text: string | null }>,
	paneId: string,
): Promise<boolean> {
	const atPrompt = async () => {
		const { text } = await readScreen({ paneId }).catch(() => ({
			text: null,
		}));
		return !!text && odinScreenStatus(text) === "review";
	};
	if (await atPrompt()) {
		await new Promise((resolve) => setTimeout(resolve, 300));
		if (await atPrompt()) return false;
	}
	await write({ paneId, data: "\x03" });
	// Stopped before it answered, Claude puts your message back in its input
	// box, and the next one sent from here would land after it: "test" then
	// "test" went in as "testtest". Clear it: Ctrl+U empties a row, Backspace
	// joins the row above.
	await new Promise((resolve) => setTimeout(resolve, 500));
	const { text } = await readScreen({ paneId }).catch(() => ({ text: null }));
	const rows = text ? inputBoxRows(text) : 0;
	if (rows > 0) await write({ paneId, data: `${"\x15\x7f".repeat(rows)}\x15` });
	return true;
}
