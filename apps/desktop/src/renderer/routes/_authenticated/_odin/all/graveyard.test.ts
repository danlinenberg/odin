import { expect, test } from "bun:test";
import { droppedWhy, putAwayWhy } from "./graveyard";

const swept = {
	key: "jira:ODIN-7",
	source: "Jira",
	title: "Old ticket",
	verdict: "DROP" as const,
	evidence: "Ticket is Done",
	droppedAt: 5,
};

test("a dropped row says why, under any profile, by key and by link", () => {
	const why = droppedWhy({
		work: {
			dropped: [
				swept,
				{
					...swept,
					key: "pr:odin#12",
					url: "https://github.com/x/odin/pull/12",
					evidence: "PR merged",
				},
			],
		},
		private: {
			dropped: [{ ...swept, key: "task:3", evidence: "21 days idle" }],
		},
		fresh: undefined,
	});
	expect(putAwayWhy({ key: "jira:ODIN-7" }, why)).toBe("Ticket is Done");
	expect(putAwayWhy({ key: "task:3" }, why)).toBe("21 days idle");
	// The feed keys the PR by id; the link joins it to the sweep's row.
	expect(
		putAwayWhy({ key: "pr:99", url: "https://github.com/x/odin/pull/12" }, why),
	).toBe("PR merged");
});

test("a row put away by Done, not dropped, has no why", () => {
	const why = droppedWhy({ work: { dropped: [swept] } });
	expect(putAwayWhy({ key: "slack:C1:2", url: null }, why)).toBeNull();
	expect(putAwayWhy({ key: "task:1" }, new Map())).toBeNull();
});

test("a row a drop rule put away is dropped too, with the rule as the why", () => {
	expect(
		putAwayWhy({ key: "slack:C1:2", rule: "Slack|person|x" }, new Map()),
	).toMatch(/^Dropped by a rule/);
});
