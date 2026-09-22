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
 *
 * ponytail: still a line count, just anchored. Its ceiling: a dialog taller
 * than this many lines above the box loses its first line, which is the one
 * that says "Do you want". Parse the box's own rule lines as a delimiter pair
 * if that ever bites.
 */
const FOOTER_LINES = 10;

/**
 * The horizontal rules Claude draws above and below its input box — the seam
 * between transcript and chrome. Matched on the run of box-drawing characters
 * so an indented or padded row still counts.
 */
const RULE = /^[\s]*[─━]{10,}[\s]*$/;

/**
 * The spinner line, which is the only thing on screen that says "mid-turn":
 *
 *   ✳ Calculating… (11m 48s · ↓ 40.9k tokens · thought for 1s)
 *   ✻ Cogitating… (5m 0s · ↑ 12.1k tokens · esc to interrupt)
 *
 * Match the "…(" that opens the counter, not the hint inside it. The hint text
 * drifts between Claude versions — "esc to interrupt" in one, "thought for 1s"
 * in the next — and keying on it called every working session Needs you, so
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
 * Returns undefined when the screen doesn't look like any of the three — an
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

export function odinScreenStatus(screen: string): PaneStatus | undefined {
	const footer = footerOf(screen);
	// Order matters: a permission dialog is drawn *over* the spinner, so it has
	// to win over the spinner, and the idle prompt's status line ("bypass
	// permissions on", "? for shortcuts") is painted under both of the others.
	if (/Enter to select|Do you want|❯[ \t]*\d+\.[ \t]/i.test(footer))
		return "permission";
	if (SPINNER.test(footer)) return "working";
	// Claude is sitting at its prompt (not mid-turn, no dialog) — the turn ended
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
 * one that finished the job clean draw the identical screen — Claude paints no
 * dialog for a question it asked in prose — and the only writer that can tell
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
 * needs is Resume — reopen the conversation with `claude --resume`.
 *
 * Claude's chrome is the tell: the spinner, a dialog, the status line, or the
 * rules around its input box. One of them is on screen in every state of the
 * TUI, and a bare shell draws none.
 */
export function agentOnScreen(screen: string): boolean {
	if (odinScreenStatus(screen) !== undefined) return true;
	// The box on its own — Claude drawn, but caught between repaints of the
	// status line under it.
	return (
		screen.split(/\r\n|\n|\r/).filter((line) => RULE.test(line)).length >= 2
	);
}

/**
 * Does Esc mean something *inside* Claude right now?
 *
 * Claude prints the affordance whenever it is — "Esc to go back" under a menu
 * or a picker, "(esc)" on the reject option of a permission dialog. The
 * board's drawer swallows Esc to close itself, which in those states steals
 * the key from the menu the user is standing in and the pane disappears
 * instead of the menu.
 *
 * "esc to interrupt" is deliberately not matched: mid-turn the drawer closing
 * is the wanted behaviour, and an Esc into the PTY there cancels the turn.
 *
 * ponytail: shares the status classifier's footer window, and its ceiling — a
 * transcript line within FOOTER_LINES of the input box that happens to say
 * "esc to go back" costs the drawer its Esc until the screen scrolls. Minimize
 * and click-outside still close it. Parse the box rules as a delimiter pair if
 * that ever bites.
 */
export function escIsHandledOnScreen(screen: string): boolean {
	return /esc(?:ape)? to (?:go back|cancel|exit|close|dismiss)|\(esc\)/i.test(
		footerOf(screen),
	);
}
