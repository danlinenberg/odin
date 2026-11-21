import { describe, expect, test } from "bun:test";
import type { AllItem } from "./all-items";
import {
	applyManualMerges,
	mergeOrder,
	mergeTicked,
	useManualMerges,
} from "./manual-merges";

function row(key: string, source: AllItem["source"], url?: string): AllItem {
	return {
		key,
		source,
		title: `Task ${key}`,
		url: url ?? null,
		details: [],
		launch: {
			key,
			title: `Task ${key}`,
			description: null,
			contact: null,
			brief: `Task ${key}`,
		},
	} as unknown as AllItem;
}

describe("mergeOrder", () => {
	test("the owning source stays, then the first listed", () => {
		const items = [
			row("slack:1", "Slack"),
			row("task:a", "Tasks"),
			row("jira:X-1", "Jira"),
			row("slack:2", "Slack"),
		];
		expect(mergeOrder(items)).toEqual([
			"jira:X-1",
			"task:a",
			"slack:1",
			"slack:2",
		]);
	});
});

describe("applyManualMerges", () => {
	const items = [
		row("slack:1", "Slack", "https://example.com/s1"),
		row("task:a", "Tasks"),
		row("slack:2", "Slack", "https://example.com/s2"),
	];

	test("no groups leaves the rows alone", () => {
		expect(applyManualMerges(items, []).map((item) => item.key)).toEqual([
			"slack:1",
			"task:a",
			"slack:2",
		]);
	});

	test("folds the group into its first row, two from one feed included", () => {
		const out = applyManualMerges(items, [["slack:2", "slack:1"]], {
			"slack:1": "ask Riley first",
		});
		expect(out.map((item) => item.key)).toEqual(["task:a", "slack:2"]);
		const merged = out[1];
		expect(merged.merged).toBe(true);
		expect(merged.also?.map((copy) => copy.key)).toEqual(["slack:1"]);
		expect(merged.details).toContainEqual([
			"Also in Slack",
			"https://example.com/s1",
		]);
		expect(merged.launch.description).toContain("https://example.com/s1");
		expect(merged.launch.description).toContain("My notes: ask Riley first");
	});

	test("a group with one row left listed does nothing", () => {
		const out = applyManualMerges(items, [["slack:1", "gone:9"]]);
		expect(out.map((item) => item.key)).toEqual([
			"slack:1",
			"task:a",
			"slack:2",
		]);
		expect(out[0].merged).toBeUndefined();
	});

	test("the first row still listed stays when the head is gone", () => {
		const out = applyManualMerges(items, [["done:1", "task:a", "slack:2"]]);
		expect(out.map((item) => item.key)).toEqual(["slack:1", "task:a"]);
		expect(out[1].also?.map((copy) => copy.key)).toEqual(["slack:2"]);
	});

	test("copies an absorbed row already carried come along", () => {
		const carrying = {
			...row("jira:X-1", "Jira"),
			also: [row("notion:p", "Notion", "https://example.com/n")],
		};
		const out = applyManualMerges(
			[row("task:a", "Tasks"), carrying],
			[["task:a", "jira:X-1"]],
		);
		expect(out).toHaveLength(1);
		expect(out[0].also?.map((copy) => copy.key)).toEqual([
			"jira:X-1",
			"notion:p",
		]);
	});
});

describe("mergeTicked (the tick-box bar's Merge)", () => {
	test("merges the ticked rows owner first, and its Undo puts them back", () => {
		useManualMerges.setState({ groups: [["old:1", "old:2"]] });
		const undo = mergeTicked([
			row("slack:1", "Slack"),
			row("jira:X-1", "Jira"),
		]);
		expect(useManualMerges.getState().groups).toEqual([
			["old:1", "old:2"],
			["jira:X-1", "slack:1"],
		]);
		undo?.();
		expect(useManualMerges.getState().groups).toEqual([["old:1", "old:2"]]);
	});

	test("one ticked row merges nothing", () => {
		useManualMerges.setState({ groups: [] });
		expect(mergeTicked([row("slack:1", "Slack")])).toBeNull();
		expect(useManualMerges.getState().groups).toEqual([]);
	});
});
