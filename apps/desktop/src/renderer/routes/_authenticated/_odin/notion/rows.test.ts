import { describe, expect, it } from "bun:test";
import { buildRowPrompt, groupByStatus, NO_STATUS } from "./rows";

const row = (pageId: string, status: string | null) => ({ pageId, status });

describe("groupByStatus", () => {
	it("sinks finished statuses and floats rows with a live session", () => {
		const groups = groupByStatus(
			[
				row("a", "Done"),
				row("b", "In progress"),
				row("c", "In progress"),
				row("d", null),
			],
			(pageId) => pageId === "c",
		);
		expect(groups.map(([status]) => status)).toEqual([
			"In progress",
			NO_STATUS,
			"Done",
		]);
		expect(groups[0][1].map((r) => r.pageId)).toEqual(["c", "b"]);
	});
});

describe("buildRowPrompt", () => {
	it("carries the page url and its fields, minus the title field", () => {
		const prompt = buildRowPrompt({
			title: "Fix the exporter",
			pageUrl: "https://notion.so/page",
			fields: { Name: "Fix the exporter", Owner: "Dana", Priority: "High" },
		});
		expect(prompt).toContain("https://notion.so/page");
		expect(prompt).toContain("- Owner: Dana");
		expect(prompt).toContain("- Priority: High");
		expect(prompt).not.toContain("- Name:");
	});
});
