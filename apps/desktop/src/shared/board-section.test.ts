import { describe, expect, it } from "bun:test";
import { bySection } from "./board-section";
import type { Pane } from "./tabs-types";

const card = (pane: Partial<Pane>) => ({ pane: pane as Pane });

describe("bySection", () => {
	it("orders sections and drops the empty ones", () => {
		const grouped = bySection([
			card({ id: "a" }),
			card({ id: "b", odinSource: "jira" }),
			card({ id: "c", odinSource: "slack" }),
			card({ id: "d", odinSource: "slack" }),
		]);
		expect(grouped.map(([section, group]) => [section, group.length])).toEqual([
			["reactions", 2],
			["jira", 1],
			["normal", 1],
		]);
	});

	// Panes launched before odinSource existed only carry the Notion pageId.
	it("reads a legacy Slack pane from its pageId", () => {
		expect(bySection([card({ id: "a", odinPageId: "p1" })])[0][0]).toBe(
			"reactions",
		);
	});

	it("lifts parked cards out of their source section, first", () => {
		const grouped = bySection([
			card({ id: "a", odinSource: "jira" }),
			card({ id: "b", odinSource: "jira", odinParked: true }),
			card({ id: "c", odinParked: true }),
		]);
		expect(grouped.map(([section, group]) => [section, group.length])).toEqual([
			["parked", 2],
			["jira", 1],
		]);
	});

	// The board clears odinParked asynchronously; a card that already moved on
	// isn't parked, whatever the stale flag says.
	it("ignores the flag on a session that started moving again", () => {
		expect(
			bySection([card({ id: "a", odinParked: true, status: "working" })])[0][0],
		).toBe("normal");
	});
});

describe("bySection with queued cards", () => {
	const queued = { command: "claude", reason: "this Mac is at 91% CPU" };

	it("gives a task that hasn't started its own section, above the rest", () => {
		const grouped = bySection([
			card({ id: "a", odinSource: "jira" }),
			card({ id: "b", odinQueued: queued, odinSource: "jira" }),
		]);
		expect(grouped.map(([section, group]) => [section, group.length])).toEqual([
			["queued", 1],
			["jira", 1],
		]);
	});

	// Parking a card that never started would otherwise list it twice.
	it("counts a queued card once, even if it's also parked", () => {
		const grouped = bySection([
			card({ id: "a", odinQueued: queued, odinParked: true, status: "idle" }),
		]);
		expect(grouped).toEqual([["queued", [{ pane: grouped[0][1][0].pane }]]]);
	});
});
