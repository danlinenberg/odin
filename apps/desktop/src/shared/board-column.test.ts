import { describe, expect, it } from "bun:test";
import { boardColumn } from "./board-column";

describe("boardColumn", () => {
	// Done, not Needs you: the turn ended and nothing is asking for you.
	it("routes an agent that ended its turn clean to Done", () => {
		expect(boardColumn("review", true, false)).toBe("review");
	});

	// The bug this guards: everything landed in Done and Needs you emptied out.
	// An alive-but-idle session has a status nobody set — `merge` cleared it on
	// restart, or acknowledging the pane did — which is not the same thing as
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

	// The bug this guards: statuses survive restart (tabs store `merge` keeps
	// "permission"/"review"/"failed") but PTYs don't, so every old session piled
	// into Needs you as a card with nothing to answer.
	it("never leaves a dead session in Needs you", () => {
		expect(boardColumn("review", false, false)).toBe("idle");
		expect(boardColumn("failed", false, false)).toBe("idle");
		expect(boardColumn("permission", false, false)).toBe("idle");
		expect(boardColumn("working", false, false)).toBe("idle");
	});

	it("leaves dead idle sessions in Idle", () => {
		expect(boardColumn("idle", false, false)).toBe("idle");
	});

	it("stops calling a dead session working or waiting on you", () => {
		expect(boardColumn("working", false, false)).toBe("idle");
		expect(boardColumn("permission", false, false)).toBe("idle");
	});

	it("does not call a session dead before the daemon poll answers", () => {
		expect(boardColumn("working", undefined, false)).toBe("working");
		expect(boardColumn("permission", undefined, false)).toBe("permission");
	});
});
