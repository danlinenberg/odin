/**
 * What you said in a message, without what Odin and Claude Code wrapped
 * around it. Pure, so the board's chat (userText) and the phone's transcript
 * (spokenText) read your messages alike.
 */

/** The line Odin adds under a reply when you dismissed action items (dismissed-actions.ts). */
export const DISMISSED_HEAD =
	"(I dismissed these action items - do not list them again:";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Claude Code files a long message as pasted text, between these tags. */
const PASTED =
	/<pasted_content id="[^"]*">\n?([\s\S]*?)\n?<\/pasted_content(?: id="[^"]*")?>/g;

/** Odin's note at the end of a message, through its closing parenthesis. */
const DISMISSED = new RegExp(
	`\\s*${escape(DISMISSED_HEAD)}\\n[\\s\\S]*?\\)\\s*$`,
);

/** Claude Code's marker for a turn you stopped: an event, not a message. */
export const isInterruptMarker = (text: string) =>
	/^\[Request interrupted by user[^\]]*\]$/.test(text.trim());

/** The message as you wrote it: pasted-text tags and Odin's dismissal note gone. */
export function withoutWrapping(text: string): string {
	return text.replace(PASTED, "$1").replace(DISMISSED, "").trim();
}
