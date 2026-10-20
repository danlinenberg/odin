import type { PaneStatus } from "./tabs-types";

/**
 * Which column a session's card belongs in. The pane's raw status isn't the
 * answer on its own:
 *  - an agent in "review" ended its turn and asked nothing - that's Done;
 *  - an ALIVE agent in "idle" only has a status nobody set, which is not the
 *    same claim, so it wants a look (Needs you) rather than Done;
 *  - a session you dragged to Idle stays parked there until it moves again;
 *  - a DEAD session can't be working, whatever its status says - but one that
 *    ended asking you something (open ACTION ITEMS, an unanswered question)
 *    still owes you that answer, so it stays in Needs you. So does one the
 *    board closed for sitting idle (`closedIn`): it keeps the column it was
 *    closed from, since closing it changed nothing you owe it;
 *  - a live "failed" session is just another thing that needs you;
 *  - a live session under `/loop` that's between turns is Idle, not Done or
 *    Needs you - it will wake itself up, so there's nothing to finish or answer.
 *
 * `alive === undefined` means the daemon poll hasn't answered yet - never call a
 * session dead on a guess, because the Idle card's Resume kills and respawns it.
 */
export function boardColumn(
	status: PaneStatus,
	alive: boolean | undefined,
	parked: boolean,
	looping = false,
	closedIn?: PaneStatus,
): PaneStatus {
	if (status === "idle" && parked) return "idle";
	// Only a mounted <Terminal> notices its PTY exit and resets the status
	// (useTerminalStream.handleTerminalExit). Board cards aren't mounted
	// terminals, so a background agent that died leaves its status frozen at
	// whatever it was - and `merge` in the tabs store deliberately carries
	// "permission"/"review"/"failed" across restarts, where every PTY is gone.
	// The daemon poll is the truth: a dead session can't be working on it. A
	// "permission" one still waits on you - the turn ended asking you something,
	// and answering it resumes the session. Anything else goes to Idle, whose
	// card offers Resume ("session ended - resume to pick it up").
	if (alive === false)
		return closedIn ?? (status === "permission" ? "permission" : "idle");
	// A prompt on screen or a failure still needs you, loop or not - the next
	// tick can't fire past it.
	if (looping && (status === "review" || status === "idle")) return "idle";
	// Done. Only the Stop hook puts a card here: "the turn ended and the agent
	// asked for nothing" is a claim about the turn, and the only writer that
	// knows it is the hook that saw the turn end.
	if (status === "review") return "review";
	//
	// Alive-but-idle joins them, and NOT Done: its status was cleared rather
	// than earned - acknowledging a pane turns "review" into idle, an Esc in
	// the terminal drops "working" - so all it says is "this session is up and
	// not working". That's worth a look, not a claim that it finished clean.
	if (status === "failed" || (alive && status === "idle")) return "permission";
	return status;
}

/**
 * A session you asked Odin to ping you about ("Ping me" on its Slack thread,
 * Jira ticket or PR) is waiting on someone else, not on you: while nothing new
 * came in, its Needs you or Done card waits in Idle. A reply or an approval
 * brings it back to Needs you. A prompt on screen or a failure still needs you,
 * whatever you are waiting for.
 *
 * `watch`: "none" = not pinging; "waiting" = pinging, nothing new;
 * "replied" = a reply or approval you haven't opened yet.
 */
export function withWaiting(
	column: PaneStatus,
	status: PaneStatus,
	watch: "none" | "waiting" | "replied",
): PaneStatus {
	if (watch === "none" || (column !== "permission" && column !== "review"))
		return column;
	if (watch === "replied") return "permission";
	if (status === "permission" || status === "failed") return column;
	return "idle";
}
