/** Pure row helpers for the Notion view — the parts worth a test. */

/** Statuses that mean "no longer waiting on me" — sunk to the bottom. */
export const isDoneish = (status: string) =>
	/done|complete|closed|reject|cancel|archiv|ship/i.test(status);

export const NO_STATUS = "No status";

export interface NotionRow {
	pageId: string;
	pageUrl: string;
	title: string;
	status: string | null;
	fields: Record<string, string>;
}

/**
 * Rows grouped by status: Notion's own row order kept inside a group, live
 * sessions first, finished statuses last.
 */
export function groupByStatus<
	T extends { pageId: string; status: string | null },
>(rows: T[], hasSession: (pageId: string) => boolean): [string, T[]][] {
	const byStatus = new Map<string, T[]>();
	for (const row of rows) {
		const key = row.status ?? NO_STATUS;
		const group = byStatus.get(key) ?? [];
		group.push(row);
		byStatus.set(key, group);
	}
	for (const group of byStatus.values())
		group.sort(
			(a, b) => Number(hasSession(b.pageId)) - Number(hasSession(a.pageId)),
		);
	return [...byStatus.entries()].sort(
		(a, b) => Number(isDoneish(a[0])) - Number(isDoneish(b[0])),
	);
}

/** Everything the page says, so the agent doesn't have to open Notion first. */
export function buildRowPrompt(
	row: Pick<NotionRow, "title" | "pageUrl" | "fields">,
): string {
	const fields = Object.entries(row.fields)
		.filter(([name]) => name.toLowerCase() !== "name")
		.map(([name, value]) => `- ${name}: ${value}`);
	return [
		`This task is the Notion page "${row.title}".`,
		`Page: ${row.pageUrl}`,
		...(fields.length > 0 ? ["", "Fields on the page:", ...fields] : []),
		"",
		"Read the page in full before changing anything, then investigate, make the change, and verify it when practical.",
		"Rules: do NOT edit the Notion page — everything stays in this session for review.",
	].join("\n");
}
