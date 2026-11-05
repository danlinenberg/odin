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
});
