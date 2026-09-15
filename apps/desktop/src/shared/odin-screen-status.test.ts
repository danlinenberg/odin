import { describe, expect, it } from "bun:test";
import { odinScreenStatus, odinScreenWrite } from "./odin-screen-status";

// The screens below are trimmed from real Claude Code sessions.
const IDLE_PROMPT = `
❯
Opus | odin | main | $1.88 | 88% free
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 7 agents
`;
// Two releases of the same line. The hint at the end of it is not stable, so
// nothing may depend on which one a session happens to be running.
const MID_TURN = `
✻ Cogitating… (5m 0s · ↑ 12.1k tokens · esc to interrupt)
`;
const MID_TURN_NO_HINT = `
✳ Calculating… (11m 48s · ↓ 40.9k tokens · thought for 1s)
`;
const TURN_DONE = `
✻ Cooked for 1m 30s
`;
const PERMISSION = `
Do you want to allow this command?
❯ 1. Yes
  2. No
`;
const TIP = `
  ⎿ Tip: Paste images into Claude Code using control+v (not cmd+v!)
`;
const RULE = "─".repeat(80);
/** The input box, drawn between two rules, holding `draft`. */
const BOX = (draft = "") => `
${RULE}
❯ ${draft}
${RULE}
  Opus | dev | main | $2.26 | 85% free
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 7 agents
`;
// One row per running background agent, painted *under* the status line.
const AGENTS = `
  ⏺ main
  ◯ general-purpose  Fetching Studio issue report pages   38s · ↓ 95.4k tokens
  ◯ general-purpose  Fetching final four Studio pages     42s · ↓ 98.6k tokens
  ◯ general-purpose  Fetch Studio report descriptions C   29s · ↓ 61.8k tokens
`;
// Ten lines of scrolled-past transcript — far enough above the chrome that
// whatever it says is none of the classifier's business.
const TRANSCRIPT = (text: string) =>
	`${text}\n${Array.from({ length: 10 }, (_, i) => `⏺ line ${i}`).join("\n")}\n`;

describe("odinScreenStatus", () => {
	it("calls a session sitting at its prompt Done, not Working", () => {
		expect(odinScreenStatus(IDLE_PROMPT)).toBe("review");
	});

	it("calls a session mid-turn Working", () => {
		expect(odinScreenStatus(MID_TURN)).toBe("working");
	});

	// The flap this guards: the spinner's trailing hint changes between Claude
	// versions, and a release that says "thought for 1s" instead of "esc to
	// interrupt" made every working session read as Needs you — so cards ran
	// Working → Needs you → Working for a whole turn as the agent hooks and the
	// 5s re-read corrected each other.
	it("calls a session mid-turn Working whatever the spinner hint says", () => {
		expect(odinScreenStatus(`${MID_TURN_NO_HINT}${IDLE_PROMPT}`)).toBe(
			"working",
		);
	});

	it("stops calling it Working once the turn is done", () => {
		expect(odinScreenStatus(`${TURN_DONE}${IDLE_PROMPT}`)).toBe("review");
	});

	it("calls a session on a dialog Needs you", () => {
		expect(odinScreenStatus(PERMISSION)).toBe("permission");
	});

	it("prefers the dialog over the spinner it is drawn on top of", () => {
		expect(odinScreenStatus(`${MID_TURN}${PERMISSION}`)).toBe("permission");
	});

	it("prefers the spinner over the status line under it", () => {
		expect(odinScreenStatus(`${MID_TURN}${IDLE_PROMPT}`)).toBe("working");
	});

	it("says nothing about a screen it doesn't recognise", () => {
		expect(odinScreenStatus("$ vim notes.md\n~\n~\n")).toBeUndefined();
	});

	// Only the chrome at the bottom of the screen knows what the agent is doing.
	// Scrolled-past transcript that quotes the classifier's own patterns used to
	// outvote it on every other 5s re-read.
	it("ignores a transcript that talks about the spinner", () => {
		const screen = `${TRANSCRIPT("the classifier keys on esc to interrupt")}${IDLE_PROMPT}`;
		expect(odinScreenStatus(screen)).toBe("review");
	});

	it("ignores a transcript that quotes a permission dialog", () => {
		const screen = `${TRANSCRIPT("DLG=/Enter to select|Do you want|❯\\s*\\d+\\.\\s/")}${MID_TURN}${IDLE_PROMPT}`;
		expect(odinScreenStatus(screen)).toBe("working");
	});

	it("does not read a truncated transcript line as a spinner", () => {
		const screen = `grep -n "ODINDBG…\n(that line was cut off)\n${IDLE_PROMPT}`;
		expect(odinScreenStatus(screen)).toBe("review");
	});

	it("splits raw PTY history on bare carriage returns", () => {
		const screen = `x = "Do you want"\r${"⏺ noise\r".repeat(10)}${MID_TURN.trim()}\r`;
		expect(odinScreenStatus(screen)).toBe("working");
	});

	// Everything below is about how far the chrome reaches. The rows under the
	// status line grow with the fleet, so a window measured from the bottom of
	// the screen loses the spinner off its top edge exactly when the session is
	// busiest — which is the flip Working → Needs you → Working, all turn.
	describe("with rows below the input box", () => {
		it("finds the spinner past a fleet of running agents", () => {
			expect(
				odinScreenStatus(`${MID_TURN_NO_HINT}${TIP}${BOX()}${AGENTS}`),
			).toBe("working");
		});

		it("finds a dialog past a fleet of running agents", () => {
			expect(odinScreenStatus(`${PERMISSION}${BOX()}${AGENTS}`)).toBe(
				"permission",
			);
		});

		it("still says Done when that session is at its prompt", () => {
			expect(odinScreenStatus(`${TURN_DONE}${BOX()}${AGENTS}`)).toBe("review");
		});

		it("finds the spinner past a long draft in the box", () => {
			const draft = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
			expect(odinScreenStatus(`${MID_TURN}${BOX(draft)}${AGENTS}`)).toBe(
				"working",
			);
		});

		it("keeps the transcript out of it", () => {
			const screen = `${TRANSCRIPT("esc to interrupt")}${TURN_DONE}${BOX()}${AGENTS}`;
			expect(odinScreenStatus(screen)).toBe("review");
		});
	});
});

// The bug this guards: the idle prompt read as "the turn is over" got written
// straight to the pane, so every session that had been sitting at its prompt
// for 20s was stamped Done — including the ones whose last message asked Dan a
// question. Done filled up and Needs you emptied out.
describe("odinScreenWrite", () => {
	it("never promotes a card into Done off a screen read", () => {
		expect(odinScreenWrite("review", "permission")).toBeUndefined();
		expect(odinScreenWrite("review", "failed")).toBeUndefined();
		expect(odinScreenWrite("review", "idle")).toBeUndefined();
	});

	it("never demotes a card out of Done off a screen read", () => {
		expect(odinScreenWrite("review", "review")).toBeUndefined();
	});

	// The one job left: a hook that never arrived leaves a card "working" for
	// hours on a session that has been at its prompt the whole time.
	it("unsticks a stale working card into Needs you", () => {
		expect(odinScreenWrite("review", "working")).toBe("permission");
	});

	it("still lets an unambiguous screen overrule the hooks", () => {
		expect(odinScreenWrite("permission", "review")).toBe("permission");
		expect(odinScreenWrite("working", "review")).toBe("working");
		expect(odinScreenWrite("permission", "working")).toBe("permission");
	});

	it("says nothing about a screen the classifier didn't recognise", () => {
		expect(odinScreenWrite(undefined, "working")).toBeUndefined();
	});
});
