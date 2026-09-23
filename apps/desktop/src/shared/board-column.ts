import type { PaneStatus } from "./tabs-types";

/**
 * Which column a session's card belongs in. The pane's raw status isn't the
 * answer on its own:
 *  - an agent in "review" ended its turn and asked nothing — that's Done;
 *  - an ALIVE agent in "idle" only has a status nobody set, which is not the
 *    same claim, so it wants a look (Needs you) rather than Done;
 *  - a session you dragged to Idle stays parked there until it moves again;
 *  - a DEAD session can't be working or waiting on you, whatever its status says;
 *  - a live "failed" session is just another thing that needs you;
 *  - a live session under `/loop` that's between turns is Idle, not Done or
 *    Needs you — it will wake itself up, so there's nothing to finish or answer.
 *
 * `alive === undefined` means the daemon poll hasn't answered yet — never call a
 * session dead on a guess, because the Idle card's Resume kills and respawns it.
 */
export function boardColumn(
	status: PaneStatus,
	alive: boolean | undefined,
	parked: boolean,
	looping = false,
): PaneStatus {
	if (status === "idle" && parked) return "idle";
	// Only a mounted <Terminal> notices its PTY exit and resets the status
	// (useTerminalStream.handleTerminalExit). Board cards aren't mounted
	// terminals, so a background agent that died leaves its status frozen at
	// whatever it was — and `merge` in the tabs store deliberately carries
	// "permission"/"review"/"failed" across restarts, where every PTY is gone.
	// The daemon poll is the truth: a dead session can't be working on it, and
	// can't be waiting on you either — there's no prompt left to answer and no
	// turn left to reply to. Its only move is Resume, which lives on the Idle
	// card ("session ended — resume to pick it up").
	if (alive === false) return "idle";
	// A prompt on screen or a failure still needs you, loop or not — the next
	// tick can't fire past it.
	if (looping && (status === "review" || status === "idle")) return "idle";
	// Done. Only the Stop hook puts a card here: "the turn ended and the agent
	// asked for nothing" is a claim about the turn, and the only writer that
	// knows it is the hook that saw the turn end.
	if (status === "review") return "review";
	// ponytail: a Failed column was one more place to look for the same call to
	// action ("this session needs you"), so failures land in Needs you too — the
	// card still says it failed.
	//
	// Alive-but-idle joins them, and NOT Done: its status was cleared rather
	// than earned — acknowledging a pane turns "review" into idle, an Esc in
	// the terminal drops "working" — so all it says is "this session is up and
	// not working". That's worth a look, not a claim that it finished clean.
	if (status === "failed" || (alive && status === "idle")) return "permission";
	return status;
}
