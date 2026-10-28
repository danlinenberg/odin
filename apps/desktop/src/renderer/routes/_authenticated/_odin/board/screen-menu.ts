import { odinScreenStatus } from "shared/odin-screen-status";

/** A pick-one menu the Claude TUI is drawing right now. */
export type ScreenMenu = {
	/** The text above the options - the question, warning or command. */
	title: string;
	options: string[];
	/** The option the `❯` cursor sits on. */
	selected: number;
	/** What Esc does here, from the footer ("Cancel", "Back"), or null. */
	escape: string | null;
};

const CURSOR = "❯";
// ▔ is the top edge of a dialog drawn over the conversation (the usage limit menu).
const RULE_RE = /^[\s─━═▔╭╮╰╯┌┐└┘├┤-]*[─━═▔]{3,}[\s─━═▔╭╮╰╯┌┐└┘├┤-]*$/;
const NUMBERED_RE = /^\s*(?:❯\s*)?(\d+)\.\s+(.+)$/;
const FOOTER_RE =
	/enter to (?:confirm|select)|esc to (?:cancel|exit|go back)|↑\/↓/i;
const ESC_RE = /esc to (cancel|exit|(?:go )?back|close)/i;
// A dialog's top edge with a notice painted into it ("▔▔▔ You're close to
// your usage limit ▔") - not a rule to RULE_RE, but the title stops there.
const EDGE_RE = /^\s*[─━═▔]{3,}/;

/** "Esc to back" reads "Back" on a button. */
function escapeLabel(footer: string): string | null {
	const action = ESC_RE.exec(footer)?.[1]?.replace(/^go /i, "");
	return action
		? action.charAt(0).toUpperCase() + action.slice(1).toLowerCase()
		: null;
}

/** Drops box sides so a boxed dialog reads like a plain one. */
function unbox(line: string): string {
	return line
		.replace(/^\s*[│┃]/, "")
		.replace(/[│┃]\s*$/, "")
		.trimEnd();
}

function indent(line: string): number {
	return line.length - line.trimStart().length;
}

/**
 * Finds the menu on a plain-text TUI screen. Only the last `❯` counts: the
 * input box draws one too, so when the last one sits under a rule the TUI
 * is waiting for typed text, not a pick, and older `❯` lines above it are
 * history.
 */
export function parseScreenMenu(screen: string): ScreenMenu | null {
	const lines = screen.split("\n").map(unbox);
	let at = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i]?.trimStart().startsWith(CURSOR)) {
			at = i;
			break;
		}
	}
	if (at < 0) return null;

	const cursorLine = lines[at] ?? "";
	const numbered = NUMBERED_RE.test(cursorLine);
	const column = cursorLine.indexOf(CURSOR) + CURSOR.length;
	const textColumn =
		column +
		(cursorLine.slice(column).length -
			cursorLine.slice(column).trimStart().length);
	const isOption = (line: string) =>
		numbered
			? NUMBERED_RE.test(line)
			: line.trim() !== "" &&
				!RULE_RE.test(line) &&
				(line.trimStart().startsWith(CURSOR) || indent(line) === textColumn);
	// A numbered option's wrapped description sits deeper than its number.
	const isDetail = (line: string) =>
		numbered &&
		line.trim() !== "" &&
		!NUMBERED_RE.test(line) &&
		indent(line) > indent(cursorLine);

	// /mcp splits its list into groups: a blank line, then a header at the
	// options' indent. A blank line joins two groups of two lines or more, so
	// a one-line title above a menu stays the title.
	const joinsGroups = (blank: number, step: 1 | -1) =>
		!numbered &&
		lines[blank]?.trim() === "" &&
		isOption(lines[blank + step] ?? "") &&
		isOption(lines[blank + 2 * step] ?? "");

	let first = at;
	while (first > 0) {
		const above = lines[first - 1] ?? "";
		if (isOption(above)) first--;
		else if (isDetail(above) && isOption(lines[first - 2] ?? "")) first -= 2;
		else if (joinsGroups(first - 1, -1)) first--;
		else break;
	}
	let last = at;
	while (last < lines.length - 1) {
		const below = lines[last + 1] ?? "";
		if (isOption(below) || isDetail(below)) last++;
		else if (joinsGroups(last + 1, 1)) last++;
		else break;
	}
	if (RULE_RE.test(lines[first - 1] ?? "")) return null;

	const span = lines.slice(first, last + 1);
	// Each group's first line is its header, which the cursor skips over.
	const grouped = span.some((line) => line.trim() === "");
	const block = span.filter(
		(line, i) =>
			isOption(line) && !(grouped && (i === 0 || span[i - 1]?.trim() === "")),
	);
	if (block.length < 2) return null;
	const options = block.map((line) =>
		numbered
			? (NUMBERED_RE.exec(line)?.[2] ?? "").trim()
			: line.trim().replace(/^❯\s*/, ""),
	);
	if (numbered) {
		const numbers = block.map((line) => Number(NUMBERED_RE.exec(line)?.[1]));
		if (numbers.some((n, i) => n !== i + 1)) return null;
	}
	const after = lines.slice(last + 1, last + 4).join("\n");
	if (!numbered && !FOOTER_RE.test(after)) return null;
	const selected = block.findIndex((line) =>
		line.trimStart().startsWith(CURSOR),
	);

	const title: string[] = [];
	for (let i = first - 1; i >= 0 && title.length < 12; i--) {
		const line = lines[i] ?? "";
		if (RULE_RE.test(line) || EDGE_RE.test(line)) break;
		title.unshift(line.trim());
	}
	return {
		title: title.join("\n").trim(),
		options,
		selected,
		escape: escapeLabel(after),
	};
}

/**
 * A dialog the TUI is drawing that parseScreenMenu can't read: its text, so
 * the chat view still says the terminal is asking instead of showing nothing.
 */
export function parseScreenDialog(screen: string): string | null {
	if (odinScreenStatus(screen) !== "permission") return null;
	const lines = screen.split("\n").map(unbox);
	const at = lines.findLastIndex(
		(line) => line.trimStart().startsWith(CURSOR) || FOOTER_RE.test(line),
	);
	// The input box's own `❯` sits right under its top rule.
	if (at < 0 || RULE_RE.test(lines[at - 1] ?? "")) return null;
	let first = at;
	while (first > 0 && at - first < 15 && !RULE_RE.test(lines[first - 1] ?? ""))
		first--;
	let last = at;
	while (last < lines.length - 1 && !RULE_RE.test(lines[last + 1] ?? ""))
		last++;
	const text = lines
		.slice(first, last + 1)
		.map((line) => line.trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return text || null;
}

/** /mcp's sign-in step: the server, and the URL it asks you to open. */
export type ScreenAuth = {
	title: string;
	url: string;
};

/**
 * /mcp's "Authenticating with <server>..." screen. It has no `❯` menu, only
 * a URL and "Press Enter after authenticating", so the menu reader skips it.
 * The URL wraps over several rows at the terminal's width; its rows have no
 * spaces, so they join back up.
 */
export function parseScreenAuth(screen: string): ScreenAuth | null {
	const lines = screen.split("\n").map((line) => unbox(line).trim());
	const enter = lines.findLastIndex((line) =>
		/press enter after authenticating/i.test(line),
	);
	if (enter < 0) return null;
	const head = lines.findLastIndex(
		(line, i) => i < enter && /^Authenticating with /.test(line),
	);
	if (head < 0 || enter - head > 12) return null;
	const start = lines.findIndex(
		(line, i) => i > head && i < enter && /^https?:\/\//.test(line),
	);
	if (start < 0) return null;
	let url = lines[start] ?? "";
	for (let i = start + 1; i < enter; i++) {
		const line = lines[i] ?? "";
		if (!line || /\s/.test(line)) break;
		url += line;
	}
	return {
		title: (lines[head] ?? "").replace(/[….]+$/, ""),
		url,
	};
}

/** Arrow from the cursor to `target`, then Enter - every Select takes these. */
export function menuKeys(menu: ScreenMenu, target: number): string[] {
	const step = target > menu.selected ? "\x1b[B" : "\x1b[A";
	return [
		...Array.from({ length: Math.abs(target - menu.selected) }, () => step),
		"\r",
	];
}

/** A `/btw` side answer: the TUI draws it over the prompt, never in the transcript. */
export type ScreenAside = {
	question: string;
	/** null while Claude is still answering. */
	answer: string | null;
};

const ASIDE_RE = /^\s*\/btw\s/;

/**
 * Finds a `/btw` overlay: its question line (no `❯` - that one is the input
 * box's echo), the answer under it, and an "Esc to close" footer.
 */
export function parseScreenAside(screen: string): ScreenAside | null {
	const lines = screen.split("\n").map((line) => line.trimEnd());
	const footer = lines.findLastIndex((line) => /esc to close/i.test(line));
	if (footer < 0) return null;
	const answering = /^\s*(\/btw\s.*?)\s+·\s+Answering/.exec(
		lines[footer] ?? "",
	);
	if (answering) return { question: answering[1] ?? "", answer: null };
	const start = lines.findLastIndex(
		(line, index) => index < footer && ASIDE_RE.test(line),
	);
	if (start < 0) return null;
	const body = lines.slice(start + 1, footer);
	const margin = Math.min(...body.filter((line) => line.trim()).map(indent));
	return {
		question: (lines[start] ?? "").trim(),
		answer: body
			.map((line) => line.slice(Number.isFinite(margin) ? margin : 0))
			.join("\n")
			.trim(),
	};
}
