import { describe, expect, test } from "bun:test";
import { newAutoStartRows } from "./auto-start";

describe("newAutoStartRows", () => {
	test("a source's first rows are its baseline: nothing starts", () => {
		const { fresh, seen } = newAutoStartRows(undefined, [
			{ source: "Jira", key: "jira:A-1" },
			{ source: "Slack", key: "slack:1" },
		]);
		expect(fresh).toEqual([]);
		expect(seen).toEqual({ Jira: ["jira:A-1"], Slack: ["slack:1"] });
	});

	test("a row that shows up after the baseline is new, once", () => {
		const first = newAutoStartRows({ Jira: ["jira:A-1"] }, [
			{ source: "Jira", key: "jira:A-1" },
			{ source: "Jira", key: "jira:A-2" },
		]);
		expect(first.fresh).toEqual([{ source: "Jira", key: "jira:A-2" }]);
		const again = newAutoStartRows(first.seen, [
			{ source: "Jira", key: "jira:A-2" },
		]);
		expect(again.fresh).toEqual([]);
		expect(again.changed).toBe(false);
	});

	test("a source seen for the first time later still gets a baseline", () => {
		const { fresh, seen } = newAutoStartRows({ Jira: ["jira:A-1"] }, [
			{ source: "GitHub", key: "pr:1" },
		]);
		expect(fresh).toEqual([]);
		expect(seen.GitHub).toEqual(["pr:1"]);
		expect(seen.Jira).toEqual(["jira:A-1"]);
	});

	test("a feed that loads empty gets an empty baseline: its first row starts", () => {
		const empty = newAutoStartRows(undefined, [], ["Slack"]);
		expect(empty.fresh).toEqual([]);
		expect(empty.seen).toEqual({ Slack: [] });
		expect(empty.changed).toBe(true);
		const next = newAutoStartRows(empty.seen, [
			{ source: "Slack", key: "slack:1" },
		]);
		expect(next.fresh).toEqual([{ source: "Slack", key: "slack:1" }]);
	});

	test("a loaded source with a baseline already keeps it", () => {
		const { seen, changed } = newAutoStartRows(
			{ Slack: ["slack:1"] },
			[],
			["Slack"],
		);
		expect(seen).toEqual({ Slack: ["slack:1"] });
		expect(changed).toBe(false);
	});

	test("a row past the cap that the feed still shows is not new again", () => {
		const old = Array.from({ length: 2000 }, (_, i) => `task:${i}`);
		const rows = [
			{ source: "Tasks", key: "task:0" },
			{ source: "Tasks", key: "task:new" },
		];
		const first = newAutoStartRows({ Tasks: old }, rows);
		expect(first.fresh).toEqual([{ source: "Tasks", key: "task:new" }]);
		expect(first.seen.Tasks).toHaveLength(2000);
		expect(first.seen.Tasks).toContain("task:0");
		expect(first.seen.Tasks).not.toContain("task:1");
		expect(newAutoStartRows(first.seen, rows).fresh).toEqual([]);
	});
});
