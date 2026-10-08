/** A pick-one menu the Claude TUI is drawing right now. */
export type ScreenMenu = {
	/** The text above the options - the question, warning or command. */
	title: string;
	options: string[];
	/** The option the `❯` cursor sits on. */
	selected: number;
};

const CURSOR = "❯";
const RULE_RE = /^[\s─━═╭╮╰╯┌┐└┘├┤-]*[─━═]{3,}[\s─━═╭╮╰╯┌┐└┘├┤-]*$/;
const NUMBERED_RE = /^\s*(?:❯\s*)?(\d+)\.\s+(.+)$/;
const FOOTER_RE =
	/enter to (?:confirm|select)|esc to (?:cancel|exit|go back)|↑\/↓/i;

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
 *
 * ponytail: text heuristics against Claude Code's Select layout (numbered
 * options, or plain ones with an "Enter to confirm" footer). A TUI layout
 * change means a missed menu - the terminal still answers it.
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

	let first = at;
	while (first > 0) {
		const above = lines[first - 1] ?? "";
		if (isOption(above)) first--;
		else if (isDetail(above) && isOption(lines[first - 2] ?? "")) first -= 2;
		else break;
	}
	let last = at;
	while (last < lines.length - 1) {
		const below = lines[last + 1] ?? "";
		if (isOption(below) || isDetail(below)) last++;
		else break;
	}
	if (RULE_RE.test(lines[first - 1] ?? "")) return null;

	const block = lines.slice(first, last + 1).filter(isOption);
	if (block.length < 2) return null;
	const options = block.map((line) =>
		numbered
			? (NUMBERED_RE.exec(line)?.[2] ?? "").trim()
			: line.trim().replace(/^❯\s*/, ""),
	);
	if (numbered) {
		const numbers = block.map((line) => Number(NUMBERED_RE.exec(line)?.[1]));
		if (numbers.some((n, i) => n !== i + 1)) return null;
	} else {
		const after = lines.slice(last + 1, last + 4).join("\n");
		if (!FOOTER_RE.test(after)) return null;
	}
	const selected = block.findIndex((line) =>
		line.trimStart().startsWith(CURSOR),
	);

	const title: string[] = [];
	for (let i = first - 1; i >= 0 && title.length < 12; i--) {
		const line = lines[i] ?? "";
		if (RULE_RE.test(line)) break;
		title.unshift(line.trim());
	}
	return {
		title: title.join("\n").trim(),
		options,
		selected,
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
