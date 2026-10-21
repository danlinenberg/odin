import { SPINNER } from "shared/odin-screen-status";

/**
 * What Claude has drawn for the turn in progress, read off its screen: the
 * lines it wrote and the command it is running now.
 *
 * The chat view is built from the transcript, and Claude Code commits a
 * message's blocks to it in one batch, seconds after the stream ends (minutes
 * when a permission check waits on you). Until then the narration before a
 * command and the command itself exist only on the terminal screen - the TUI
 * draws its stream live. Reading them off the screen is what lets the chat
 * view show the same steps the terminal does, while Claude works.
 */
export type ScreenStep =
	| { kind: "text"; text: string }
	| { kind: "tool"; text: string };

/** Claude's mark on a block it drew: ● today, ⏺ in some builds. */
const BULLET = /^[●⏺]\s+/;
/**
 * The prompt you sent, echoed at the top of its turn ("> …"), or your message
 * still in the input box ("❯ …") on a frame the TUI had not finished drawing
 * over. Either way nothing above it is this turn. Not "❯ 1. Yes": that is the
 * cursor on a dialog's option, under Claude's lines.
 */
const PROMPT = /^[>❯]\s(?!\d+\.\s)/;
/** The previous turn's closing line: "✻ Cooked for 2m 3s · done 10:11 AM". */
const DONE = /^[^\w\s●⏺]\s+\w+ for \d+[hms]\b/;
/** The row under a command: its output, "Running…", a hook's note. */
const OUTPUT = /^\s*⎿/;
/** A tool call drawn by name, with no description: "Bash(python3 …)". */
const CALL = /^[A-Z][A-Za-z]*\(/;
/** "· 6s" at the end of a running command's heading. */
const TIMER = /[\s ]+·[\s ]+\d+[hms](?:\s\d+[hms])*$/;
/** That timer, or the "· summary" tag the TUI hangs on a line it wrote. */
const TAG = /[\s ]+·[\s ]+(?:summary|\d+[hms](?:\s\d+[hms])*)$/;
/** The TUI's own digest of the stream so far, which it tags "· summary". */
const SUMMARY = /[\s ]+·[\s ]+summary$/;
/** A row that ends a sentence - the row before a digest's first row does. */
const SENTENCE_END = /[.!?:]$/;
/** The first row of a list item, which the row above never runs into. */
const ITEM = /^\s*(?:\d+\.|[-•◦▪*])\s/;
/** A one-word state under a command, still going: "⎿  Running…". */
const RUNNING = /^\s*⎿\s+\S+…$/;
const RULE = /^[\s]*[─━]{10,}[\s]*$/;
/** How far above the input box the spinner can sit (see odin-screen-status). */
const FOOTER_LINES = 10;

const rows = (screen: string) =>
	screen.split(/\r\n|\n|\r/).map((line) => line.replace(/\s+$/, ""));

/**
 * Where the turn's output ends on screen: the spinner row, or the top of the
 * input box when no spinner is drawn (a dialog is up). The spinner is looked
 * for only just above the box, like `odinScreenStatus` does - prose with an
 * ellipsis before a bracket must not cut the turn short.
 */
function endOfOutput(lines: string[]): number {
	const rules = lines.flatMap((line, i) => (RULE.test(line) ? [i] : []));
	const boxTop =
		rules.length >= 2 ? (rules.at(-2) ?? lines.length) : lines.length;
	for (let i = boxTop - 1; i >= Math.max(0, boxTop - FOOTER_LINES); i--)
		if (SPINNER.test(lines[i] ?? "")) return i;
	return boxTop;
}

/** One block as drawn: the rows between blank lines. */
function blocks(lines: string[]): string[][] {
	const out: string[][] = [];
	let current: string[] = [];
	for (const line of lines) {
		if (!line.trim()) {
			if (current.length) out.push(current);
			current = [];
		} else current.push(line);
	}
	if (current.length) out.push(current);
	return out;
}

const words = (text: string) => text.replace(/\s+/g, " ").trim();

/** A block's rows as drawn, Claude's mark replaced by the indent under it. */
const drawn = (block: string[]) =>
	block.map((line, i) => (i === 0 ? line.replace(BULLET, "  ") : line));

/** A block's heading: its rows before any output row, unwrapped, tag and all. */
function heading(block: string[]): string {
	const end = block.findIndex((line) => OUTPUT.test(line));
	const head = drawn(end < 0 ? block : block.slice(0, end)).map((line) =>
		line.trim(),
	);
	return words(head.join(" "));
}

/**
 * A text block's rows as the lines Claude wrote. The TUI wraps a line at the
 * pane's width, so a row with no room for the next row's first word runs on
 * into it, and a row with room to spare ends its line: a paragraph break, a
 * line of code, a list item (which no row runs into). The digest the TUI tags
 * "· summary" is its own words for the stream, not Claude's, and goes - with
 * the rows above it back to the end of the sentence before it.
 */
function textLines(block: string[], width: number): string[] {
	const all = drawn(block);
	const drop = new Set<number>();
	all.forEach((line, i) => {
		if (!SUMMARY.test(line)) return;
		let from = i;
		while (from > 0 && !SENTENCE_END.test(all[from - 1] ?? "")) from--;
		for (let j = from; j <= i; j++) drop.add(j);
	});
	const kept = all.filter((_, i) => !drop.has(i));
	const lines: string[] = [];
	kept.forEach((line, i) => {
		const next = kept[i + 1];
		const text = words(line);
		if (lines.length && lines.at(-1)?.endsWith(" ")) {
			lines[lines.length - 1] += text;
		} else lines.push(text);
		const word = next?.trim().split(/\s+/)[0] ?? "";
		const wraps =
			next !== undefined &&
			!ITEM.test(next) &&
			line.length + 1 + word.length > width;
		if (wraps) lines[lines.length - 1] += " ";
	});
	return lines.map((line) => line.replace(TAG, "").trim()).filter(Boolean);
}

/**
 * The steps of the turn in progress, top to bottom: each line Claude wrote
 * since your prompt, and the command running now. Finished commands are left
 * out - their rows land in the transcript with the message - and so is
 * everything above your prompt, which is the previous turn.
 *
 * Undefined for a torn frame: the TUI repaints only the cells that changed,
 * and a frame caught between two paints shows the last one through the new
 * one - stale columns inside a row, rows where a blank should be. Its rows
 * read as prose would splice the two ("RundthemSELECTiabove"); nothing on it
 * can be trusted, so the caller keeps what it last showed.
 */
export function screenSteps(screen: string): ScreenStep[] | undefined {
	const lines = rows(screen);
	const width = Math.max(0, ...lines.map((line) => line.length));
	const end = endOfOutput(lines);
	const start = lines.findLastIndex(
		(line, i) => i < end && (PROMPT.test(line) || DONE.test(line)),
	);
	let body = lines.slice(start + 1, end);
	// A long prompt wraps onto indented rows under its "> ": they're yours,
	// not Claude's, and end at the first blank row.
	if (start >= 0 && PROMPT.test(lines[start] ?? "")) {
		const blank = body.findIndex((line) => !line.trim());
		body = blank < 0 ? [] : body.slice(blank);
	}
	// Every row of Claude's block sits under its mark, two columns in. One
	// that doesn't, anywhere on screen, is the frame before showing through.
	const claudes = (block: string[]) =>
		BULLET.test(block[0] ?? "") || /^\s{2}\S/.test(block[0] ?? "");
	const torn = blocks(lines.slice(0, end)).some(
		(block) =>
			claudes(block) && block.some((line, i) => i > 0 && /^\s?\S/.test(line)),
	);
	if (torn) return undefined;
	const steps: ScreenStep[] = [];
	for (const block of blocks(body)) {
		const first = block[0] ?? "";
		// A hook's note or a tip stands alone under ⎿; a dialog or a spinner
		// remnant carries no mark. Only Claude's own blocks count.
		if (!claudes(block)) continue;
		if (OUTPUT.test(first)) continue;
		const head = heading(block);
		const text = head.replace(TAG, "");
		if (!text) continue;
		const output = block.some((line) => OUTPUT.test(line));
		const running =
			TIMER.test(head) || block.some((line) => RUNNING.test(line));
		if (output || CALL.test(head)) {
			if (running) steps.push({ kind: "tool", text });
			continue;
		}
		const body = textLines(block, width).join("\n");
		// Digits and marks alone are a fragment of a frame, not a line.
		if (/\p{L}/u.test(body)) steps.push({ kind: "text", text: body });
	}
	return steps;
}

/**
 * Text as it compares across the screen and the transcript: letters and
 * digits only, one space between words. The TUI draws Markdown - `**bold**`
 * as bold, `[a link](url)` as its words - so the marks can't take part.
 */
const plain = (text: string) =>
	words(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " "));

/**
 * The steps the transcript has not recorded yet, so the chat view shows each
 * once. A line counts as recorded when a reply of this turn contains its
 * first words - the screen wraps and can be scrolled, so it may hold only
 * part of a line. The running command counts as recorded once the transcript
 * holds any command of this turn still without its result.
 */
export function unrecordedSteps<T extends ScreenStep>(
	steps: T[],
	turn: { kind: string; text?: string; result?: string }[],
): T[] {
	const replies = turn.flatMap((item) =>
		item.kind === "text" && item.text ? [plain(item.text)] : [],
	);
	const commandRunning = turn.some(
		(item) => item.kind === "tool" && item.result === undefined,
	);
	return steps.filter((step) => {
		if (step.kind === "tool") return !commandRunning;
		const head = plain(step.text).slice(0, 60);
		return head.length > 0 && !replies.some((reply) => reply.includes(head));
	});
}

/** A step on show, with when it first showed - its row's time, like a message's. */
export type ShownStep = ScreenStep & { at: number };

/** The steps on show, and the last read of the screen, for `settleSteps`. */
export type Settled = { shown: ShownStep[]; last?: ScreenStep[] };

export const UNSETTLED: Settled = { shown: [] };

/** `b` carries on from `a`: the same line, with more of it streamed. */
const continues = (a: ScreenStep, b: ScreenStep | undefined) =>
	b !== undefined && a.kind === b.kind && b.text.startsWith(a.text);

const same = (a: ScreenStep[], b: ScreenStep[]) =>
	a.length === b.length &&
	a.every((step, i) => step.kind === b[i]?.kind && step.text === b[i]?.text);

/**
 * What to show after one more read of the screen, at `now`. A read shows once
 * the next read agrees with it, or at once when it only adds to what shows -
 * a line still streaming grows by the word, and a command appears under it.
 * A torn read (undefined) changes nothing. Shown straight off each poll, the
 * row flickered: a frame caught mid-paint read as a different line, or as no
 * line, for a second at a time.
 */
export function settleSteps(
	state: Settled,
	read: ScreenStep[] | undefined,
	now = Date.now(),
): Settled {
	if (!read) return state;
	const grows =
		state.shown.length > 0 &&
		state.shown.length <= read.length &&
		state.shown.every((step, i) => continues(step, read[i]));
	const agreed = state.last !== undefined && same(state.last, read);
	if (!grows && !agreed) return { shown: state.shown, last: read };
	if (same(state.shown, read)) return { shown: state.shown, last: read };
	// A line keeps its time as it grows; a new one is from now.
	const shown = read.map((step, i) => {
		const was = state.shown[i];
		return { ...step, at: was && continues(was, step) ? was.at : now };
	});
	return { shown, last: read };
}
