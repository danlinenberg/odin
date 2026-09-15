import { expect, test } from "bun:test";
import { feedCounts, feedIssues, isBot } from "./feed-counts";

test("bots are the ones the PR view hides", () => {
	expect(isBot("renovate[bot]")).toBe(true);
	expect(isBot("dependabot")).toBe(true);
	expect(isBot("danlinenberg")).toBe(false);
});

test("counts say what's waiting, not how many rows", () => {
	const counts = feedCounts({
		tasks: 2,
		slack: [
			{ status: "Not started" },
			{ status: "In progress" },
			{ status: "Done" },
		],
		jira: [{}, {}, {}],
		pulls: [{ author: "dan" }, { author: "renovate[bot]" }],
		notion: [],
	});
	expect(counts).toEqual({
		// All is what the other five add up to, so the strip agrees with itself.
		"/all": 7,
		"/my-tasks": 2,
		"/reactions": 1,
		"/jira": 3,
		"/prs": 1,
		"/notion": 0,
	});
});

test("a source is marked signed-out, or signed-in and failing", () => {
	expect(
		feedIssues({
			"/reactions": { connected: false },
			// A live token that stopped working is the case a token check misses.
			"/prs": { connected: true, failed: true },
			"/jira": { connected: true, failed: false },
		}),
	).toEqual({ "/reactions": "off", "/prs": "error" });
	// Still loading: no dot yet, rather than one on every launch.
	expect(feedIssues({ "/prs": {} })).toEqual({});
});
