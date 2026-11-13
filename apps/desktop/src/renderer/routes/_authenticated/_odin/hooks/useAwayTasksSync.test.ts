import { describe, expect, it } from "bun:test";
import { doneChecker } from "renderer/stores/done-check";
import { hostDone } from "./useAwayTasksSync";

describe("hostDone", () => {
	it("hides rows a session took here, even after a newer mention", () => {
		const sent = hostDone({ "jira:A-1": { at: 5, url: null } }, ["pr:7"]);
		const isDone = doneChecker(
			Object.fromEntries(
				Object.entries(sent).map(([k, r]) => [
					k,
					{ ...r, title: "", source: "" },
				]),
			),
		);
		expect(
			isDone({ key: "pr:7", mention: { at: new Date().toISOString() } }),
		).toBe(true);
		expect(isDone({ key: "jira:A-1" })).toBe(true);
		expect(isDone({ key: "task:open" })).toBe(false);
	});

	it("keeps a Done row's own time, so a newer mention still brings it back", () => {
		expect(
			hostDone({ "slack:1": { at: 5, url: "u" } }, ["slack:1"])["slack:1"],
		).toEqual({
			at: 5,
			url: "u",
		});
	});
});
