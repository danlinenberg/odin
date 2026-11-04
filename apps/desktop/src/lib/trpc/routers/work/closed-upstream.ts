/**
 * Work closed in its own tool - a Jira ticket moved to Done, a merged or
 * closed PR, a closed ClickUp task. The feeds only fetch open work, so
 * without these queries a ticket finished in Jira never shows up in All's
 * "Show what's Done". Each source asks for what is related to me and closed
 * in the last `days` days; All only asks while the Done list is on.
 */

/** One item closed upstream, the same shape for every source. */
export interface ClosedUpstreamRow {
	/** "jira:KEY", "github:<id>", "clickup:<id>" - unique across sources. */
	key: string;
	source: "Jira" | "GitHub" | "ClickUp";
	title: string;
	url: string;
	/** What it says it is now: the Jira status, "merged", "closed". */
	state: string;
	/** When it closed, ISO. */
	closedAt: string;
}

/** How far back "recently" closed reaches. */
export const CLOSED_UPSTREAM_DAYS = 14;

/**
 * Tickets assigned to me or filed by me that entered a Done status in the
 * last `days` days. statusCategoryChangedDate rather than `resolved`: a
 * workflow that never sets a resolution still moves the category.
 */
export function jiraClosedJql(days: number): string {
	return `(assignee = currentUser() OR reporter = currentUser()) AND statusCategory = Done AND statusCategoryChangedDate >= -${days}d ORDER BY statusCategoryChangedDate DESC`;
}

/** The calendar date `days` days before `now`, as GitHub's search wants it. */
export function sinceDate(days: number, now = Date.now()): string {
	return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * GitHub searches for threads of mine that closed since `since`: PRs I
 * wrote (merged or not), PRs I reviewed, and issues assigned to me.
 */
export function githubClosedQueries(since: string): string[] {
	return [
		`is:pr author:@me is:closed closed:>=${since} archived:false`,
		`is:pr reviewed-by:@me -author:@me is:closed closed:>=${since} archived:false`,
		`is:issue assignee:@me is:closed closed:>=${since} archived:false`,
	];
}

/**
 * A workspace's tasks assigned to me that were done after `sinceMs`.
 * include_closed is what lets a closed task come back at all.
 */
export function clickupClosedPath(
	teamId: string,
	userId: number,
	sinceMs: number,
): string {
	return `team/${teamId}/task?assignees[]=${userId}&include_closed=true&subtasks=true&date_done_gt=${sinceMs}&order_by=updated`;
}

/** Newest first, and one row per key when several searches return it. */
export function mergeClosed(rows: ClosedUpstreamRow[]): ClosedUpstreamRow[] {
	const seen = new Set<string>();
	return rows
		.filter((row) => {
			if (seen.has(row.key)) return false;
			seen.add(row.key);
			return true;
		})
		.sort((a, b) => b.closedAt.localeCompare(a.closedAt));
}
