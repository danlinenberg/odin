import { expect, test } from "bun:test";
import type { AllItem } from "./all-items";
import { mergeDuplicates } from "./merge-duplicates";

const item = (
	key: string,
	source: AllItem["source"],
	title: string,
	extra: Partial<AllItem> = {},
): AllItem =>
	({
		key,
		source,
		title,
		url: `https://example.com/${key}`,
		body: null,
		details: [],
		...extra,
	}) as AllItem;

test("a Jira ticket, its Notion copy and the Slack ask about it are one row, owned by Jira", () => {
	const slack = item("slack:1", "Slack", "can you look at this", {
		body: "can you look at BUGT-12 when you get a sec",
	});
	const notion = item(
		"notion:1",
		"Notion",
		"Login button does nothing on Safari",
	);
	const jira = item(
		"jira:BUGT-12",
		"Jira",
		"BUGT-12: Login button does nothing on Safari",
	);
	const other = item("jira:BUGT-13", "Jira", "Something else entirely here");

	const rows = mergeDuplicates([slack, notion, jira, other]);
	expect(rows.map((row) => row.key)).toEqual(["jira:BUGT-12", "jira:BUGT-13"]);
	expect(rows[0].also?.map((row) => row.key)).toEqual(["notion:1", "slack:1"]);
	expect(rows[0].details).toEqual([
		["Also in Notion", "https://example.com/notion:1"],
		["Also in Slack", "https://example.com/slack:1"],
	]);
});

test("two rows from one source, short titles, and a ticket citing another stay apart", () => {
	const rows = mergeDuplicates([
		item("jira:A-1", "Jira", "Fix the login flow on Safari"),
		item("jira:A-2", "Jira", "Fix the login flow on Safari"),
		item("notion:1", "Notion", "Report issue"),
		item("slack:1", "Slack", "Report issue"),
		item("github:1", "GitHub", "Refactor auth", { body: "Follow-up to A-1" }),
	]);
	expect(rows.map((row) => row.also)).toEqual([
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
	]);
});
