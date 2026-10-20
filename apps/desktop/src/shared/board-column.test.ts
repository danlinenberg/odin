import { describe, expect, it } from "bun:test";
import { boardColumn, withWaiting } from "./board-column";

describe("boardColumn", () => {
	// Done, not Needs you: the turn ended and nothing is asking for you.
	it("routes an agent that ended its turn clean to Done", () => {
		expect(boardColumn("review", true, false)).toBe("review");
	});

	// The bug this guards: everything landed in Done and Needs you emptied out.
	// An alive-but-idle session has a status nobody set - `merge` cleared it on
	// restart, or acknowledging the pane did - which is not the same thing as
	// "the agent finished and asked for nothing".
	it("does not call an alive-but-idle session Done", () => {
		expect(boardColumn("idle", true, false)).toBe("permission");
	});

	it("keeps a live prompt in Needs you", () => {
		expect(boardColumn("permission", true, false)).toBe("permission");
	});

	it("keeps a parked session in Idle even while its session is alive", () => {
		expect(boardColumn("idle", true, true)).toBe("idle");
	});

	it("still shows a parked session's real state once it moves again", () => {
		expect(boardColumn("working", true, true)).toBe("working");
	});

	it("routes a live failed session to Needs you", () => {
		expect(boardColumn("failed", true, false)).toBe("permission");
		expect(boardColumn("failed", true, true)).toBe("permission");
	});

	// Statuses survive restart (tabs store `merge` keeps them) but PTYs don't. A
	// dead session that ended asking you something still owes you the answer;
	// any other dead session goes to Idle to resume.
	it("keeps a dead session that asked you something in Needs you", () => {
		expect(boardColumn("permission", false, false)).toBe("permission");
		expect(boardColumn("review", false, false)).toBe("idle");
		expect(boardColumn("failed", false, false)).toBe("idle");
		expect(boardColumn("working", false, false)).toBe("idle");
	});

	it("leaves dead idle sessions in Idle", () => {
		expect(boardColumn("idle", false, false)).toBe("idle");
	});

	it("stops calling a dead session working", () => {
		expect(boardColumn("working", false, false)).toBe("idle");
	});

	it("does not call a session dead before the daemon poll answers", () => {
		expect(boardColumn("working", undefined, false)).toBe("working");
		expect(boardColumn("permission", undefined, false)).toBe("permission");
	});

	// A looping session ends every turn clean, but it isn't done: it'll wake
	// itself up again. Between ticks it sits in Idle.
	it("puts a looping session between turns in Idle", () => {
		expect(boardColumn("review", true, false, true)).toBe("idle");
		expect(boardColumn("idle", true, false, true)).toBe("idle");
	});

	it("still shows a looping session working or waiting on you", () => {
		expect(boardColumn("working", true, false, true)).toBe("working");
		expect(boardColumn("permission", true, false, true)).toBe("permission");
		expect(boardColumn("failed", true, false, true)).toBe("permission");
	});

	// Closed by the board for sitting idle: it keeps its column instead of
	// dropping to Idle like any other dead session.
	it("keeps an idle-closed session in the column it was closed from", () => {
		expect(boardColumn("review", false, false, false, "review")).toBe("review");
		expect(boardColumn("idle", false, false, false, "permission")).toBe(
			"permission",
		);
		expect(boardColumn("review", false, false)).toBe("idle");
	});
});

describe("withWaiting", () => {
	it("moves a pinged Done or Needs you card to Idle while nothing new came in", () => {
		expect(withWaiting("review", "review", "waiting")).toBe("idle");
		expect(withWaiting("permission", "idle", "waiting")).toBe("idle");
	});

	it("brings it back to Needs you when a reply or approval comes in", () => {
		expect(withWaiting("review", "review", "replied")).toBe("permission");
	});

	it("keeps a prompt on screen or a failure in Needs you", () => {
		expect(withWaiting("permission", "permission", "waiting")).toBe(
			"permission",
		);
		expect(withWaiting("permission", "failed", "waiting")).toBe("permission");
	});

	it("leaves working cards and unpinged ones alone", () => {
		expect(withWaiting("working", "working", "waiting")).toBe("working");
		expect(withWaiting("review", "review", "none")).toBe("review");
	});
});
