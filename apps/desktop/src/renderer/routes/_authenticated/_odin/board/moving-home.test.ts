import { describe, expect, test } from "bun:test";
import {
	endMove,
	type HeldMessage,
	holdForMove,
	isMoving,
	startMove,
	withHeld,
} from "./moving-home";

const message = (text: string): HeldMessage => ({
	text,
	sent: () => undefined,
	lost: () => undefined,
});

describe("moving-home", () => {
	test("a pane that isn't moving holds nothing", () => {
		expect(isMoving("idle")).toBe(false);
		expect(holdForMove("idle", message("hi"))).toBe(false);
		expect(endMove("idle")).toEqual([]);
	});

	test("messages sent during a move ride on the resume, oldest first", () => {
		startMove("pane");
		expect(isMoving("pane")).toBe(true);
		expect(holdForMove("pane", message("first"))).toBe(true);
		expect(holdForMove("pane", message("second"))).toBe(true);
		const held = endMove("pane");
		expect(isMoving("pane")).toBe(false);
		expect(withHeld("You were moved.", held)).toBe(
			"You were moved.\n\nfirst\n\nsecond",
		);
		// Once it landed, the next one goes the usual way.
		expect(holdForMove("pane", message("third"))).toBe(false);
	});

	test("with nothing held the resume is just the note", () => {
		expect(withHeld("You were moved.", [])).toBe("You were moved.");
	});
});
