import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkRouter } from ".";
import {
	type ClosedUpstreamRow,
	clickupClosedPath,
	githubClosedQueries,
	jiraClosedJql,
	mergeClosed,
	sinceDate,
} from "./closed-upstream";

describe("closed upstream queries", () => {
	it("asks Jira for my Done tickets that moved in the window", () => {
		expect(jiraClosedJql(14)).toBe(
			"(assignee = currentUser() OR reporter = currentUser()) AND statusCategory = Done AND statusCategoryChangedDate >= -14d ORDER BY statusCategoryChangedDate DESC",
		);
	});

	it("dates GitHub's window by calendar day", () => {
		expect(sinceDate(14, Date.parse("2026-11-04T12:00:00Z"))).toBe(
			"2026-10-21",
		);
	});

	it("asks GitHub for my closed PRs, reviews and assigned issues", () => {
		expect(githubClosedQueries("2026-10-21")).toEqual([
			"is:pr author:@me is:closed closed:>=2026-10-21 archived:false",
			"is:pr reviewed-by:@me -author:@me is:closed closed:>=2026-10-21 archived:false",
			"is:issue assignee:@me is:closed closed:>=2026-10-21 archived:false",
		]);
	});

	it("asks ClickUp for closed tasks assigned to me, done since the cutoff", () => {
		const path = clickupClosedPath("9001", 42, 1_700_000_000_000);
		const params = new URL(`https://x/${path}`).searchParams;
		expect(path.startsWith("team/9001/task?")).toBe(true);
		expect(params.get("assignees[]")).toBe("42");
		expect(params.get("include_closed")).toBe("true");
		expect(params.get("date_done_gt")).toBe("1700000000000");
	});

	it("keeps one row per key, newest first", () => {
		const row = (key: string, closedAt: string): ClosedUpstreamRow => ({
			key,
			source: "GitHub",
			title: key,
			url: `https://github.com/${key}`,
			state: "merged",
			closedAt,
		});
		expect(
			mergeClosed([
				row("a", "2026-11-01T00:00:00Z"),
				row("b", "2026-11-03T00:00:00Z"),
				row("a", "2026-11-01T00:00:00Z"),
			]).map((r) => r.key),
		).toEqual(["b", "a"]);
	});
});

describe("recentlyClosed", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
		delete process.env.ODIN_CONFIG_PATH;
	});

	it("labels a merged PR merged and a closed one closed, skipping sources not connected", async () => {
		const dir = mkdtempSync(join(tmpdir(), "odin-closed-"));
		const path = join(dir, "odin.json");
		writeFileSync(path, JSON.stringify({ githubToken: "gho_test" }));
		process.env.ODIN_CONFIG_PATH = path;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const q = new URL(String(input)).searchParams.get("q") ?? "";
			const items = q.includes("author:@me is:closed")
				? [
						{
							id: 1,
							title: "merged one",
							html_url: "https://github.com/o/r/pull/1",
							closed_at: "2026-11-02T00:00:00Z",
							pull_request: { merged_at: "2026-11-02T00:00:00Z" },
						},
						{
							id: 2,
							title: "closed one",
							html_url: "https://github.com/o/r/pull/2",
							closed_at: "2026-11-03T00:00:00Z",
							pull_request: { merged_at: null },
						},
					]
				: [];
			return new Response(JSON.stringify({ items }), { status: 200 });
		}) as typeof fetch;
		const { rows } = await createWorkRouter()
			.createCaller({} as never)
			.recentlyClosed();
		expect(rows.map((r) => [r.key, r.state])).toEqual([
			["github:2", "closed"],
			["github:1", "merged"],
		]);
	});
});
