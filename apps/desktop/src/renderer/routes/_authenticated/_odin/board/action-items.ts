import { actionItemLines } from "./brief";

export { actionItemEntries } from "./brief";

/**
 * Reading a reply's ACTION ITEMS block: where it starts, its items, their
 * [A | B] choices, and which kind each is. Pure, so the board's chat and the
 * iPhone app (renderer/mobile) read a reply the same way.
 */

/**
 * Split a reply at its ACTION ITEMS line, in any of the shapes agents write it
 * ("ACTION ITEMS:", "## Action items", "**ACTION ITEMS:** none ..."). Whatever
 * follows on that line stays with the items.
 */
export function splitActionItems(text: string): {
	body: string;
	actions: string | null;
} {
	const match = text.match(/^[#>*_\s]*ACTION ITEMS\b[*_:\s]*(.*)$/im);
	if (match?.index === undefined) return { body: text, actions: null };
	const rest = text.slice(match.index + match[0].length);
	return {
		body: text.slice(0, match.index).trim(),
		actions: `${match[1] ?? ""}${rest}`.trim() || null,
	};
}

/** An item that asks you to sign off - it gets an Approve button, "(you only)" or not. */
export function isApprovalItem(item: string): boolean {
	return /^\W*approve\b/i.test(item);
}

/** The numbered or bulleted lines of an ACTION ITEMS block; [] for "none". */
export const actionItemList = actionItemLines;

/**
 * An item that asks you to tell Claude something - a choice, a value, a
 * preference. It gets a reply box instead of a bare "Do it".
 */
export function isAnswerItem(item: string): boolean {
	return (
		!isDoneItem(item) &&
		/^\W*(tell|answer|decide|choose|pick|confirm|let me know|say)\b/i.test(item)
	);
}

/**
 * "Tell me when you have authorized X" - the only reply is "done", so it gets
 * a Done button and no reply box.
 */
export function isDoneItem(item: string): boolean {
	return (
		/^\W*(tell me|let me know)\s+(when|once|after)\b/i.test(item) &&
		itemOptions(item).options.length === 0
	);
}

/**
 * The choices Claude offered as a trailing "[A | B | C]", and the item without
 * them. The launch prompt asks for that shape; no brackets means no choices.
 */
export function itemOptions(item: string): { text: string; options: string[] } {
	// An option may hold a link ("after [#826](url) merges"); a button shows its words.
	// A trailing "(you only)" still counts: you pick, so the choices are buttons.
	// So does the item's link after them - "Decide #903 [merge | close] <url>" - which stays in the text.
	const match = item.match(
		/\s*\[((?:[^[\]]|\[[^\]]*\]\([^)]*\))*\|(?:[^[\]]|\[[^\]]*\]\([^)]*\))*)\](?!\()\s*(?:\(you only\))?(\s*(?:https?:\/\/\S+|\[[^\]]*\]\([^)]*\)))?\W*$/i,
	);
	if (match?.index === undefined) return { text: item, options: [] };
	const link = match[2]?.trim();
	return {
		text: item.slice(0, match.index) + (link ? ` ${link}` : ""),
		options: (match[1] ?? "")
			.split("|")
			.map((option) => option.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim())
			.filter(Boolean),
	};
}

/**
 * What an item's button sends: the typed answer, "Done" for a "tell me when"
 * item, else nothing - and Claude is asked to do the item itself.
 */
export function itemReply(item: string, answer: string): string | undefined {
	const typed = answer.trim();
	if (typed) return typed;
	return !isApprovalItem(item) && isDoneItem(item) ? "Done" : undefined;
}

/** Claude marks what it can't do "(you only)"; handing it back is a dead-end turn. */
export function isYouOnly(item: string): boolean {
	return (
		/\(you only\)\W*$/i.test(item) &&
		!isApprovalItem(item) &&
		!isAnswerItem(item) &&
		itemOptions(item).options.length === 0
	);
}
