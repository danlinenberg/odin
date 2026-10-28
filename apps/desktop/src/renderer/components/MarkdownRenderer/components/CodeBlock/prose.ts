// Pure helpers for drafts in a reply, shared by the desktop's CodeBlock and
// the phone's markdown (renderer/mobile/markdown.tsx), which can't load
// CodeBlock's stores and tRPC.

// A `text` fence is almost always a draft message to paste somewhere
// (Slack, email, a PR), so it reads as wrapped prose, not numbered code.
export const PROSE_LANGUAGES = new Set(["text", "txt", "plaintext"]);

/** Hebrew or Arabic letters: a right-to-left draft, which rarely ends its lines with a period. */
const RTL_LETTERS = /[\u0590-\u05FF\u0600-\u06FF]/;

/**
 * Mostly Hebrew or Arabic letters. Not dir="auto", which goes by the first
 * letter only: "btw כרגע..." or a leading <@U123> mention would read left-to-right.
 */
export function isRtlText(text: string): boolean {
	const letters = text.replace(/<@[UW][A-Z0-9]+>/g, "");
	const rtl = letters.match(/[\u0590-\u05FF\u0600-\u06FF]/g)?.length ?? 0;
	const ltr = letters.match(/[A-Za-z]/g)?.length ?? 0;
	return rtl > 0 && rtl >= ltr;
}

/** A word of a sentence: letters or a number, maybe with trailing punctuation. */
const PLAIN_WORD = /^[("'`]?[\p{L}\d][\p{L}\d'’.,:;%)?!"`-]*$/u;

/** A code comment, or a line that ends like code: a long English one is still code. */
const CODE_LINE = /^\s*(?:#|\/\/|--|\/\*|\*)|[{};]\s*$/;

/**
 * A long line that ends a sentence, or one that is mostly plain words: drafts
 * often skip the final period, while a command's flags, paths and `=` aren't words.
 */
function isSentence(line: string, codeAround: boolean): boolean {
	const words = line.trim().split(/\s+/);
	if (words.length < 12) return false;
	if (/[.?!]$/.test(line.trim())) return true;
	return (
		!codeAround &&
		words.filter((word) => PLAIN_WORD.test(word)).length / words.length >= 0.8
	);
}

export function looksLikeProse(code: string): boolean {
	const lines = code.split("\n");
	const codeAround = lines.some((line) => CODE_LINE.test(line));
	return (
		RTL_LETTERS.test(code) || lines.some((line) => isSentence(line, codeAround))
	);
}

/** The right-to-left mark: invisible, it makes a line read right-to-left. */
const RLM = "\u200F";

/**
 * Each line with Hebrew or Arabic in it starts with RLM, so Slack lays it out
 * right-to-left: "1." and a closing "?" land on the right side, not the left.
 */
export function markRtlLines(text: string): string {
	return text
		.split("\n")
		.map((line) =>
			RTL_LETTERS.test(line) && !line.startsWith(RLM) ? RLM + line : line,
		)
		.join("\n");
}
