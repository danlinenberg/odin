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

// Docs lists files, not tasks - there is no task row to share.
for (const { to, label } of FEED_TABS.filter(({ to }) => to !== "/docs")) {
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
