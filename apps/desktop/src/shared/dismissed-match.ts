import { DISMISSED_HEAD } from "./user-text";

/**
 * Action items you dismissed: matching one in new words, and the note that
 * tells Claude. Pure, so the board (stores/dismissed-actions.ts) and the
 * phone read a dismissal alike.
 */

const words = (item: string) =>
	new Set(
		item
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // a link shows its words
			.replace(/\[[^\]]*\|[^\]]*\]/g, " ") // the choices change between replies
			.replace(/\(you only\)/gi, " ")
			.toLowerCase()
			.replace(/[^a-z0-9#/]+/g, " ")
			.split(" ")
			.filter(Boolean),
	);

/**
 * Whether `item` is one you dismissed, in the same or new words.
 */
export function isDismissed(dismissed: string[], item: string): boolean {
	const a = words(item);
	return dismissed.some((other) => {
		const b = words(other);
		const shared = [...a].filter((word) => b.has(word)).length;
		const all = new Set([...a, ...b]).size;
		return all > 0 && shared / all >= 0.6;
	});
}

/** `text` plus the note telling Claude to stop listing `untold`. */
export function withDismissalNote(text: string, untold: string[]): string {
	if (!untold.length) return text;
	const list = untold.map((item) => `- ${item}`).join("\n");
	return `${text}\n\n${DISMISSED_HEAD}\n${list})`;
}
