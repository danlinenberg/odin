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
/** The prompt you sent, echoed at the top of its turn. */
const PROMPT = /^>\s/;
/** The row under a command: its output, "Running…", a hook's note. */
const OUTPUT = /^\s*⎿/;
/** A tool call drawn by name, with no description: "Bash(python3 …)". */
const CALL = /^[A-Z][A-Za-z]*\(/;
/** "· 6s" at the end of a running command's heading. */
const TIMER = /[\s ]+·[\s ]+\d+[hms](?:\s\d+[hms])*$/;
/** That timer, or the "· summary" tag the TUI hangs on a line it wrote. */
const TAG = /[\s ]+·[\s ]+(?:summary|\d+[hms](?:\s\d+[hms])*)$/;
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

/** A block's heading: its rows before any output row, unwrapped, tag and all. */
function heading(block: string[]): string {
	const end = block.findIndex((line) => OUTPUT.test(line));
	const head = (end < 0 ? block : block.slice(0, end))
		.map((line, i) => (i === 0 ? line.replace(BULLET, "") : line))
		.map((line) => line.trim());
	return words(head.join(" "));
}

/**
 * The steps of the turn in progress, top to bottom: each line Claude wrote
 * since your prompt, and the command running now. Finished commands are left
 * out - their rows land in the transcript with the message - and so is
 * everything above your prompt, which is the previous turn.
 */
export function screenSteps(screen: string): ScreenStep[] {
	const lines = rows(screen);
	const end = endOfOutput(lines);
	const start = lines.findLastIndex((line, i) => i < end && PROMPT.test(line));
	let body = lines.slice(start + 1, end);
	// A long prompt wraps onto indented rows under its "> ": they're yours,
	// not Claude's, and end at the first blank row.
	if (start >= 0) {
		const blank = body.findIndex((line) => !line.trim());
		body = blank < 0 ? [] : body.slice(blank);
	}
	const steps: ScreenStep[] = [];
	for (const block of blocks(body)) {
		const first = block[0] ?? "";
		// A hook's note or a tip stands alone under ⎿; a dialog or a spinner
		// remnant carries no mark. Only Claude's own blocks count.
		if (!BULLET.test(first) && !/^\s{2}\S/.test(first)) continue;
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
		steps.push({ kind: "text", text });
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
export function unrecordedSteps(
	steps: ScreenStep[],
	turn: { kind: string; text?: string; result?: string }[],
): ScreenStep[] {
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
