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
});
