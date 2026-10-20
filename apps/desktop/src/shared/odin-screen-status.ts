import type { PaneStatus } from "./tabs-types";

/**
 * How much of the screen gets a vote. Claude paints its spinner, its dialogs
 * and its status line in the last handful of lines; everything above is
 * transcript, and transcript is just text the agent happened to print. Reading
 * the whole screen let that text outvote the UI: a session sitting at its
 * prompt read as Working because the agent had written "esc to interrupt" in a
 * sentence, and a working session read as Needs you whenever a test file
 * containing "Do you want" was on screen.
 *
 * Counted from the input box rather than from the bottom of the screen,
 * because the bottom of the screen moves: the status line, and one row per
 * running background agent, sit *below* the box, and with a fleet of them the
 * spinner fell off the top of a window measured from the end. That read a
 * mid-turn session as Needs you, the Start hooks read it back as Working, and
 * cards flipped every few seconds all turn.
 */
const FOOTER_LINES = 10;

/**
 * The horizontal rules Claude draws above and below its input box - the seam
 * between transcript and chrome. Matched on the run of box-drawing characters
 * so an indented or padded row still counts.
 */
const RULE = /^[\s]*[─━]{10,}[\s]*$/;

/**
 * The top edge of the /btw side-question panel. While it's open Claude draws
 * no input box, no status line and no "…(" spinner - this edge is the only
 * chrome left, and missing it read every /btw as Claude gone from the PTY.
 */
const BTW_EDGE = /^[\s]*▔{10,}[\s]*$/;

/**
 * Claude's first-run setup - the splash, the text-style picker, the folder
 * trust question, the bypass-permissions warning. None of it draws the input
 * box or a status line, so a fresh machine's first session read as Claude
 * gone: the card offered Resume and the drawer hid the terminal behind
 * "Starting session...", with the question nobody could see.
 */
const SETUP =
	/Welcome to Claude Code|Choose the text style|Do you trust the files in this folder|Is this a project you created or one you trust|Bypass Permissions mode/;

/**
 * A remote session's pane before it reaches the host: SSM and ssh take 10s or
 * more, and an expired AWS sign-in waits on you. Read as Claude gone, the drawer
 * offered Resume again, and the next click killed the connect in progress.
 */
const REMOTE_CONNECTING = /^Odin: connecting to /m;

/**
 * The spinner line, which is the only thing on screen that says "mid-turn":
 *
 *   ✳ Calculating… (11m 48s · ↓ 40.9k tokens · thought for 1s)
 *   ✻ Cogitating… (5m 0s · ↑ 12.1k tokens · esc to interrupt)
 *
 * Match the "…(" that opens the counter, not the hint inside it. The hint text
 * drifts between Claude versions - "esc to interrupt" in one, "thought for 1s"
 * in the next - and keying on it called every working session Needs you, so
 * cards flipped Working → Needs you → Working for a whole turn as the hooks
 * and this classifier corrected each other every few seconds. The finished
 * line ("✻ Cooked for 1m 30s") has no ellipsis and no counter, so it doesn't
 * match. `[ \t]` rather than `\s`: a transcript line that Claude truncated
 * with "…" must not pair up with a "(" on the line below it.
 */
const SPINNER = /…[ \t]*\(|esc to interrupt/i;

/**
 * What a Claude session's terminal screen says it's doing, for board cards
 * whose agent hooks went missing. Hooks are the fast path; this is the one
 * that can't silently stop firing, because the screen is always there.
 *
 * Returns undefined when the screen doesn't look like any of the three - an
 * unrecognised screen must leave the hook-driven status alone rather than
 * guess.
 */
function footerOf(screen: string): string {
	// Bare \r shows up in raw PTY history, where a split on \n alone would fold
	// the whole screen onto one line and hand the transcript its vote back.
	const lines = screen.split(/\r\n|\n|\r/).filter((line) => line.trim());
	// The input box is the last pair of rules; take the window from its top
	// edge, and everything below it, so however many agent rows are running
	// they can't push the spinner out. No box on screen (a bare shell, a
	// snapshot caught mid-repaint) falls back to the bottom of the screen.
	const rules = lines.flatMap((line, i) => (RULE.test(line) ? [i] : []));
	const boxTop = rules.length >= 2 ? rules[rules.length - 2] : lines.length;
	return lines.slice(Math.max(0, boxTop - FOOTER_LINES)).join("\n");
}

/**
 * Claude paints a run of spaces as "cursor forward" (ESC[nC). An ANSI strip
 * drops it and glues the words: "bypass permissions on" reads
 * "bypasspermissionson", the idle prompt goes unseen, and the raven waited out
 * its timeout without typing the question. Call before stripping.
 */
export const spacesForCursorForward = (ansi: string): string =>
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
	ansi.replace(/\x1b\[(\d*)C/g, (_, n) => " ".repeat(Number(n) || 1));

/**
 * What the agent is doing right now, from its spinner line, for the phone's
 * session view: "✻ Cogitating… (5m 0s · ↑ 12.1k tokens · esc to interrupt)"
 * reads "Cogitating… 5m 0s". Undefined when no spinner is on screen.
 */
export function odinActivity(screen: string): string | undefined {
	const line = footerOf(screen)
		.split("\n")
		.findLast((each) => SPINNER.test(each));
	const match = line?.match(/([A-Za-z][\w ]*…)[ \t]*\(([^·)]*)/);
	if (!match?.[1]) return undefined;
	const elapsed = match[2]?.trim();
	return elapsed ? `${match[1]} ${elapsed}` : match[1];
}

export function odinScreenStatus(screen: string): PaneStatus | undefined {
	const footer = footerOf(screen);
	// Order matters: a permission dialog is drawn *over* the spinner, so it has
	// to win over the spinner, and the idle prompt's status line ("bypass
	// permissions on", "? for shortcuts") is painted under both of the others.
	// "Enter to confirm" is the folder-trust dialog, whose options carry no
	// numbers - missing it read a session waiting on "Yes, I trust this
	// folder" as Claude gone from the PTY, and the card as died mid-turn.
	// No "Do you want": dialogs draw "❯ 1." too, and Claude's prose asks it just above the box.
	if (/Enter to (?:select|confirm)|❯[ \t]*\d+\.[ \t]/i.test(footer))
		return "permission";
	if (SPINNER.test(footer)) return "working";
	// Claude is sitting at its prompt (not mid-turn, no dialog) - the turn ended
	// and nothing is asking for you. That's "review" (the board's Done column),
	// not idle and not "needs input".
	if (/bypass permissions|for shortcuts|shift\+tab to cycle/i.test(footer))
		return "review";
	return undefined;
}

/**
 * What to actually write after reading a screen, given what the agent hooks
 * last said. Screen-reading is a repair tool, not an authority, and the idle
 * prompt is the read it's least sure about: it says the turn is over and
 * nothing more. A session that asked you a question in its final message and
 * one that finished the job clean draw the identical screen - Claude paints no
 * dialog for a question it asked in prose - and the only writer that can tell
 * them apart is the Stop hook that watched the turn end.
 *
 * So a "review" read never moves a card into Done and never moves one out. All
 * it does is unstick a card the hooks left on "working", which is the case
 * screen-reading exists for; that lands in Needs you, same as it did before
 * Done existed. A dialog and a spinner are unambiguous and still overrule
 * whatever the hooks said.
 *
 * Returns undefined to leave the status alone.
 */
export function odinScreenWrite(
	read: PaneStatus | undefined,
	current: PaneStatus | undefined,
): PaneStatus | undefined {
	if (read !== "review") return read;
	return current === "working" ? "permission" : undefined;
}

/**
 * Is Claude still the thing running in this PTY?
 *
 * A pane can be alive to the daemon and have no conversation in it: Ctrl+C out
 * of Claude (or /exit) and the shell it was launched from outlives it, sitting
 * at a prompt. The board used to read that as "session is open" and offer
 * Continue, which types the word "Continue" at zsh. What that session actually
 * needs is Resume - reopen the conversation with `claude --resume`.
 *
 * Claude's chrome is the tell: the spinner, a dialog, the status line, or the
 * rules around its input box. One of them is on screen in every state of the
 * TUI, and a bare shell draws none.
 */
export function agentOnScreen(screen: string): boolean {
	if (odinScreenStatus(screen) !== undefined) return true;
	if (SETUP.test(screen) || REMOTE_CONNECTING.test(screen)) return true;
	// The box on its own - Claude drawn, but caught between repaints of the
	// status line under it.
	const lines = screen.split(/\r\n|\n|\r/);
	return (
		lines.filter((line) => RULE.test(line)).length >= 2 ||
		lines.some((line) => BTW_EDGE.test(line))
	);
}

/**
 * Does Esc mean something *inside* Claude right now?
 *
 * Claude prints the affordance whenever it is - "Esc to go back" (or "Esc to
 * back", as /mcp's server panel says) under a menu
 * or a picker, "(esc)" on the reject option of a permission dialog. The
 * board's drawer swallows Esc to close itself, which in those states steals
 * the key from the menu the user is standing in and the pane disappears
 * instead of the menu.
 *
 * "esc to interrupt" is deliberately not matched: mid-turn the drawer closing
 * is the wanted behaviour, and an Esc into the PTY there cancels the turn.
 */
export function escIsHandledOnScreen(screen: string): boolean {
	return /esc(?:ape)? to (?:go back|back|cancel|exit|close|dismiss)|\(esc\)/i.test(
		footerOf(screen),
	);
}

/**
 * How many rows of text sit in Claude's input box: the rows between its last
 * pair of rules, less the "❯" prompt mark. 0 when there's no box on screen.
 */
export function inputBoxRows(screen: string): number {
	const lines = screen.split(/\r\n|\n|\r/);
	const rules = lines.flatMap((line, i) => (RULE.test(line) ? [i] : []));
	if (rules.length < 2) return 0;
	return lines
		.slice((rules.at(-2) ?? 0) + 1, rules.at(-1))
		.filter((line) => line.replace(/^\s*❯/, "").trim()).length;
}
