import { expect, test } from "bun:test";
import { allItems } from "./all-items";

const iso = (day: number) => new Date(Date.UTC(2026, 0, day)).toISOString();

const feeds = {
	tasks: [
		{ id: "t1", title: "Write the thing", createdAt: Date.UTC(2026, 0, 3) },
	],
	slack: [
		{
			id: "s1",
			title: "can you look at this",
			status: "Not started",
			permalink: "https://slack/1",
			channelName: "eng",
			authorName: "Ada",
			postedAt: iso(5),
		},
		{
			id: "s2",
			title: "already on it",
			status: "In progress",
			permalink: "https://slack/2",
			channelName: "eng",
			authorName: "Ada",
			postedAt: iso(6),
		},
	],
	jira: [
		{
			key: "BUGT-1",
			title: "It breaks",
			url: "https://jira/BUGT-1",
			project: "BUGT",
			status: "Open",
			priority: "Highest",
			reporter: "Grace",
			updated: iso(4),
		},
	],
	pulls: [
		{
			url: "https://gh/1",
			title: "Fix it",
			repo: "odin",
			number: 7,
			author: "dan",
			updated: iso(2),
		},
		{
			url: "https://gh/2",
			title: "Bump lockfile",
			repo: "odin",
			number: 8,
			author: "renovate[bot]",
			updated: iso(9),
		},
	],
	notion: [
		{
			pageId: "n1",
			title: "Q1 plan",
			pageUrl: "https://notion/1",
			status: "In progress",
			assignee: "Dan",
			priority: "P1",
			updatedAt: iso(1),
			date: null,
		},
	],
};

test("every source in one list, newest first", () => {
	expect(allItems(feeds).map((item) => [item.source, item.title])).toEqual([
		["Slack", "can you look at this"],
		["Jira", "BUGT-1: It breaks"],
		["Tasks", "Write the thing"],
		["GitHub", "odin#7: Fix it"],
		["Notion", "Q1 plan"],
	]);
});

test("holds what the tab badges claim — no started Slack, no bots", () => {
	const titles = allItems(feeds).map((item) => item.title);
	expect(titles).not.toContain("already on it");
	expect(titles).not.toContain("odin#8: Bump lockfile");
});

test("my own tasks carry a priority and no upstream link", () => {
	const task = allItems(feeds).find((item) => item.source === "Tasks");
	// Nothing typed means Medium, same as the list it came from.
	expect(task?.priority).toBe("Medium");
	expect(task?.url).toBeNull();
	expect(task?.to).toBe("/my-tasks");
});

test("a row carries its source's who / where / how it stands", () => {
	const by = (source: string) =>
		allItems(feeds).find((item) => item.source === source);
	expect([by("Jira")?.person, by("Jira")?.status, by("Jira")?.context]).toEqual(
		["Grace", "Open", "BUGT"],
	);
	// Slack has no status of its own, and its channel reads as a channel.
	expect([
		by("Slack")?.person,
		by("Slack")?.status,
		by("Slack")?.context,
	]).toEqual(["Ada", null, "#eng"]);
	// Whatever the source calls the level, in its own words.
	expect([by("Jira")?.priority, by("Notion")?.priority]).toEqual([
		"Highest",
		"P1",
	]);
	// Slack and PRs have no scale of their own to report.
	expect([by("Slack")?.priority, by("GitHub")?.priority]).toEqual([null, null]);
	// The column is for the repo, not the org every repo shares.
	const orged = allItems({
		...feeds,
		pulls: [{ ...feeds.pulls[0], repo: "acme/odin" }],
	});
	expect(orged.find((item) => item.url === "https://gh/1")?.context).toBe(
		"odin",
	);
});

test("an undated row sinks instead of sorting as 1970", () => {
	const undated = { ...feeds.jira[0], key: "BUGT-2", updated: null };
	const items = allItems({ ...feeds, jira: [undated] });
	expect(items.at(-1)?.source).toBe("Jira");
});
