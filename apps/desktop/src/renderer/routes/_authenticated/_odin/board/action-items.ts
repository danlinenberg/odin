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

/** An ACTION ITEMS block that says nothing is left ("none - shipped"). */
export function noActionItems(actions: string): boolean {
	return (
		/^[\W\d]*none\b/i.test(actions) && actionItemList(actions).length === 0
	);
}

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

/** The `! command` blocks Claude hands you to run in the session, without the `!`. */
export function bangCommands(text: string): string[] {
	return [...text.matchAll(/```[^\n]*\n\s*!([\s\S]*?)\n?```/g)]
		.map((match) => (match[1] ?? "").trim())
		.filter(Boolean);
}

/**
 * The command of a `!local command` block: one Claude hands you for your own
 * computer rather than its session (a remote session runs on its host). Null
 * for an ordinary `!` command.
 */
export function localCommand(command: string): string | null {
	return command.match(/^local\s+([\s\S]+)$/)?.[1]?.trim() || null;
}

/**
 * What each `! command` does, in Claude's words: the line it wrote right above
 * the block ("A read-only preview:"). A block straight after another block has none.
 */
export function bangCommandNotes(text: string): Record<string, string> {
	const notes: Record<string, string> = {};
	for (const match of text.matchAll(/```[^\n]*\n\s*!([\s\S]*?)\n?```/g)) {
		const command = (match[1] ?? "").trim();
		const above = text
			.slice(0, match.index)
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.at(-1);
		if (!command || !above || above.startsWith("```")) continue;
		notes[command] = above.replace(/^(?:[-*+]|\d+[.)])\s+/, "");
	}
	return notes;
}

/**
 * The `!` commands you can run from the phone: those of Claude's latest reply
 * that has any. The phone shows their Run buttons and the Mac runs only these.
 */
export function runnableCommands(
	messages: { role: string; text: string }[],
): string[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const commands = bangCommands(message.text);
		if (commands.length) return commands;
	}
	return [];
}

// Words every item uses; sharing one says nothing about which paragraph it means.
const DETAIL_FILLER = new Set(
	"tell what with whether also your this that them they then when have will should about from into once after before merge check open review approve decide choose pick confirm".split(
		" ",
	),
);

/** An item's or paragraph's telling words; a name with `.`, `-`, `_`, `/` or digits counts twice. */
function detailWords(text: string): Map<string, number> {
	const words = new Map<string, number>();
	const prose = text
		.toLowerCase()
		.replace(/\]\([^)]*\)/g, "]")
		.replace(/https?:\/\/\S+/g, " ");
	for (const word of prose.match(
		/[\p{L}\p{N}][\p{L}\p{N}._/-]*[\p{L}\p{N}]/gu,
	) ?? []) {
		const name = /[._/\d-]/.test(word);
		if ((word.length >= 4 || /^\d{2,}$/.test(word)) && !DETAIL_FILLER.has(word))
			words.set(word, name ? 2 : 1);
	}
	return words;
}

/**
 * The paragraph of the reply that explains an item - one that names it ("item
 * 3 below"), else the one sharing the most of its words, and at least one name
 * or two words. null when none does.
 */
export function itemDetail(
	item: string,
	body: string,
	number?: number,
): string | null {
	const blocks = body.split(/\n\s*\n/);
	const named =
		number !== undefined &&
		blocks.find((block) => new RegExp(`\\bitem ${number}\\b`, "i").test(block));
	if (named) return named.trim();
	const words = detailWords(itemOptions(item).text);
	let best: string | null = null;
	let top = 1;
	for (const block of blocks) {
		let score = 0;
		for (const [word, weight] of detailWords(block))
			if (words.has(word)) score += weight;
		if (score > top) {
			best = block.trim();
			top = score;
		}
	}
	return best;
}
