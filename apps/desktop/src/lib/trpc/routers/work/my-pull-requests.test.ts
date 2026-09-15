import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkRouter } from ".";

/**
 * myPullRequests against a stubbed GitHub search, same trick as the Jira
 * test: a temp `ODIN_CONFIG_PATH` with a non-expiring token is enough for
 * `githubAccessToken()`, and only `fetch` is replaced — which makes the three
 * search queries readable as assertions.
 */

const realFetch = globalThis.fetch;
let queries: string[] = [];

/** One row per search, plus a PR that two searches both claim. */
const RESULTS: Record<string, { id: number; number: number }[]> = {
	"author:@me": [{ id: 1, number: 11 }],
	"review-requested:@me": [{ id: 2, number: 22 }],
	// 2 is the PR I was asked to review AND named on; 3 is a plain issue.
	"mentions:@me": [
		{ id: 2, number: 22 },
		{ id: 3, number: 33 },
	],
};

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "odin-prs-"));
	const path = join(dir, "odin.json");
	writeFileSync(path, JSON.stringify({ githubToken: "gho_test" }));
	process.env.ODIN_CONFIG_PATH = path;

	queries = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const q = new URL(String(input)).searchParams.get("q") ?? "";
		queries.push(q);
		const bucket = Object.keys(RESULTS).find((who) => q.includes(who));
		return new Response(
			JSON.stringify({
				items: (RESULTS[bucket ?? ""] ?? []).map((row) => ({
					...row,
					html_url: `https://github.com/odin/odin/pull/${row.number}`,
					title: "a thread",
					repository_url: "https://api.github.com/repos/odin/odin",
					user: { login: "someone" },
					updated_at: "2026-09-14T10:00:00Z",
				})),
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.ODIN_CONFIG_PATH;
});

const call = () =>
	createWorkRouter()
		.createCaller({} as never)
		.myPullRequests();

describe("myPullRequests", () => {
	it("asks GitHub the three ways a thread becomes mine", async () => {
		await call();
		expect(queries.sort()).toEqual([
			"is:open is:pr author:@me archived:false",
			"is:open is:pr review-requested:@me archived:false",
			"is:open mentions:@me archived:false",
		]);
	});

	it("labels each row with why it is in the list, once, strongest claim first", async () => {
		const { pulls } = await call();
		expect(pulls.map((pull) => [pull.id, pull.kind])).toEqual([
			[1, "mine"],
			[2, "review"],
			[3, "mentioned"],
		]);
	});
});
