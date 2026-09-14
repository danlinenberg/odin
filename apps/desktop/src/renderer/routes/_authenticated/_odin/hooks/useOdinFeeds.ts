import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * Every external feed Odin shows — my Slack :eyes: reactions, my Jira, my
 * PRs, the picked Notion database — mounted in one place. The shell calls it on boot so they all
 * sync in the background at launch (and on reload), and every view's Sync
 * button refreshes the lot instead of only what's on screen.
 *
 * Callers must share these exact inputs+options: React Query keys queries by
 * them, so a mismatch fetches again instead of reusing the warm cache.
 */
export function useOdinFeeds() {
	const { data: workConfig } = electronTrpc.work.getConfig.useQuery();

	const jira = electronTrpc.work.myJiraIssues.useQuery(
		{},
		{
			enabled: workConfig?.hasJira === true,
			refetchInterval: 120_000,
			staleTime: 120_000,
			refetchOnMount: false,
			placeholderData: (prev) => prev,
		},
	);

	const pulls = electronTrpc.work.myPullRequests.useQuery(undefined, {
		enabled: workConfig?.hasGithub === true,
		refetchInterval: 120_000,
		staleTime: 120_000,
		refetchOnMount: false,
		placeholderData: (prev) => prev,
	});

	// The query itself pulls from Slack, so the interval IS the poll. Slack's
	// reactions.list is tier 2 (~20 req/min) — 2 minutes is far inside it.
	const reactions = electronTrpc.slack.reactions.useQuery(undefined, {
		refetchInterval: 120_000,
		staleTime: 120_000,
		refetchOnMount: false,
		placeholderData: (prev) => prev,
	});

	// Rows of whichever Notion database is picked in the Tasks view. No pick
	// (or no token) means no query — the view says so instead.
	const { data: notionConfig } = electronTrpc.notion.getConfig.useQuery();
	const notionDatabaseId = notionConfig?.defaultDatabaseId ?? "";
	const notion = electronTrpc.notion.queryDatabase.useQuery(
		{ databaseId: notionDatabaseId },
		{
			enabled: notionDatabaseId.length > 0,
			refetchInterval: 120_000,
			staleTime: 120_000,
			refetchOnMount: false,
			placeholderData: (prev) => prev,
		},
	);

	return {
		workConfig,
		reactions,
		jira,
		pulls,
		notion,
		notionConfig,
		notionDatabaseId,
		isSyncing:
			reactions.isFetching ||
			jira.isFetching ||
			pulls.isFetching ||
			notion.isFetching ||
			notion.isFetching,
		// refetch() ignores `enabled` (TanStack v5 fetches on an explicit call
		// either way), so syncing a source that was never signed in runs it
		// anyway and answers "Jira isn't connected" — an error raised by a feed
		// deliberately switched off. Sync only what's configured.
		syncAll: () =>
			Promise.all([
				reactions.refetch(),
				workConfig?.hasJira === true ? jira.refetch() : null,
				workConfig?.hasGithub === true ? pulls.refetch() : null,
				notionDatabaseId.length > 0 ? notion.refetch() : null,
			]),
	};
}
