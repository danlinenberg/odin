import { describe, expect, it } from "bun:test";
import { boardTags, odinSessionInFlight, withOdinTag } from "./odin-tags";
import type { Pane } from "./tabs-types";

const ODIN = "/Users/dan/dev/private/odin";

describe("withOdinTag", () => {
	it("tags the repo itself and its worktrees", () => {
		expect(withOdinTag(undefined, ODIN, ODIN)).toEqual(["odin"]);
		expect(withOdinTag(["bugs"], `${ODIN}/.worktrees/x`, ODIN)).toEqual([
			"bugs",
			"odin",
		]);
	});

	it("leaves other repos alone", () => {
		expect(withOdinTag(["bugs"], "/Users/dan/dev/imagen", ODIN)).toEqual([
			"bugs",
		]);
		// A sibling checkout whose path merely starts with the same characters.
		expect(withOdinTag(undefined, `${ODIN}-old`, ODIN)).toBeUndefined();
		expect(withOdinTag(undefined, ODIN, null)).toBeUndefined();
	});

	it("does not duplicate an explicit tag", () => {
		expect(withOdinTag(["odin"], ODIN, ODIN)).toEqual(["odin"]);
	});
});

describe("boardTags", () => {
	it("keeps the list and drops what the old vocabulary left behind", () => {
		expect(boardTags(["odin", "perf", "chore", "api"])).toEqual([
			"odin",
			"chore",
		]);
		expect(boardTags(undefined)).toEqual([]);
	});
});

describe("odinSessionInFlight", () => {
	const ODIN = "/Users/dan/dev/private/odin";
	const pane = (over: Partial<Pane>): Pane =>
		({
			id: "p1",
			tabId: "t1",
			type: "terminal",
			name: "session",
			status: "working",
			initialCwd: ODIN,
			...over,
		}) as Pane;

	it("finds the agent currently working in Odin's checkout", () => {
		expect(
			odinSessionInFlight([pane({ odinTaskTitle: "Fix the board" })], ODIN),
		).toEqual({ paneId: "p1", title: "Fix the board" });
	});

	// Stopped to ask permission is still mid-run: it owns the tree.
	it("counts a session parked on a permission prompt", () => {
		expect(
			odinSessionInFlight([pane({ status: "permission" })], ODIN),
		).not.toBeNull();
	});

	// The agent has stopped in both — holding a launch until the board is tidy
	// would mean holding it until you tidy the board.
	it("ignores sessions that have stopped", () => {
		expect(odinSessionInFlight([pane({ status: "review" })], ODIN)).toBeNull();
		expect(odinSessionInFlight([pane({ status: "idle" })], ODIN)).toBeNull();
		expect(odinSessionInFlight([pane({ status: "failed" })], ODIN)).toBeNull();
		expect(odinSessionInFlight([pane({ completed: true })], ODIN)).toBeNull();
	});

	it("counts a worktree of the checkout, and nothing outside it", () => {
		expect(
			odinSessionInFlight([pane({ initialCwd: `${ODIN}/.worktrees/x` })], ODIN),
		).not.toBeNull();
		expect(
			odinSessionInFlight([pane({ initialCwd: `${ODIN}-old` })], ODIN),
		).toBeNull();
		expect(
			odinSessionInFlight(
				[pane({ initialCwd: "/Users/dan/dev/imagen" })],
				ODIN,
			),
		).toBeNull();
	});

	// An agent that cds into /tmp mid-run still holds the tree it started in.
	it("goes by where the session was launched, not where it wandered", () => {
		expect(
			odinSessionInFlight([pane({ initialCwd: ODIN, cwd: "/tmp" })], ODIN),
		).not.toBeNull();
	});

	it("blocks nothing when Odin's checkout isn't configured", () => {
		expect(odinSessionInFlight([pane({})], null)).toBeNull();
		expect(odinSessionInFlight([], ODIN)).toBeNull();
	});
});
