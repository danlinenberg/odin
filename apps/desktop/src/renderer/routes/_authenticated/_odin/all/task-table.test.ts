import { expect, test } from "bun:test";
import { FEED_TABS } from "../components/feed-counts";

/**
 * Every Tasks tab draws its rows with the one table (TaskTable.tsx), so a task
 * looks the same and sits in the same columns wherever it shows. Driven by
 * FEED_TABS: a new connection's tab is checked the day it's added.
 *
 * The smoke test checks the same thing on screen - the same task's columns at
 * the same x on All and on its own tab.
 */
const page = (to: string) =>
	Bun.file(`${import.meta.dir}/..${to}/page.tsx`).text();

for (const { to, label } of FEED_TABS) {
	test(`${label} draws its rows with the shared task table`, async () => {
		const source = await page(to);
		expect(source).toContain("<TaskRow");
		expect(source).toContain("<TaskTableHeader");
		expect(source).toContain("TABLE_LIST");
		// The row markup each feed used to draw for itself. All keeps some for
		// its live sessions and Done list, which aren't task rows.
		if (to === "/all") return;
		for (const own of [
			"FEED_ROW",
			"ROW_LINK_SLOT",
			"ROW_PRIMARY_SLOT",
			"META_PERSON",
		])
			expect(source).not.toContain(own);
	});
}

test("the row's priority picker: your level over the source's, or the task's own", async () => {
	const { priorityChoice } = await import("./TaskTable");
	const row = { key: "jira:SHIP-1", source: "Jira", priority: "P2" };
	const jira = priorityChoice(row as never, {});
	expect([jira.value, jira.source]).toEqual(["", "P2"]);
	const mine = priorityChoice(
		{ ...row, priority: "High", sourcePriority: "P2" } as never,
		{ "jira:SHIP-1": "High" },
	);
	expect([mine.value, mine.source]).toEqual(["High", "P2"]);
	const own = priorityChoice(
		{ key: "task:a", source: "Tasks", priority: "Low" } as never,
		{},
	);
	expect([own.value, own.source]).toEqual(["1", null]);
});
