/**
 * What to write to Claude's PTY for a message. Multi-line text goes as a
 * bracketed paste, or each newline would send. So does a lone "?": typed on
 * an empty input box it toggles Claude's shortcuts help instead of landing
 * in the box, and the Enter after it sends nothing.
 */
export function typedText(text: string): string {
	return text.includes("\n") || text === "?"
		? `\x1b[200~${text}\x1b[201~`
		: text;
}
