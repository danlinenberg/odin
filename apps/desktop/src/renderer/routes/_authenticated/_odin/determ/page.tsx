import { createFileRoute } from "@tanstack/react-router";
import { ConnectNotice } from "renderer/components/ConnectProvider/ConnectProvider";
import {
	TABLE_LIST,
	TaskRow,
	TaskTableHeader,
	useTaskRows,
} from "../all/TaskTable";
import { useFeedItems } from "../all/use-all-items";
import { FeedHeader, SyncButton } from "../components/FeedChrome";
import { FeedError } from "../components/FeedError";
import { useDone } from "../hooks/useDone";
import { useOdinFeeds } from "../hooks/useOdinFeeds";

export const Route = createFileRoute("/_authenticated/_odin/determ/")({
	component: DetermPage,
});

/**
 * The last week of mentions in the Determ feeds linked in Settings → Connections. Open takes you to the mention. Done takes the row out of Odin only.
 */
function DetermPage() {
	const { determ: feed, workConfig, syncAll, isSyncing } = useOdinFeeds();
	const { isDone } = useDone();
	const rows = (feed.data?.mentions ?? []).filter(
		(row) => !isDone({ key: `determ:${row.id}`, url: row.url }),
	);
	const items = useFeedItems({ determ: rows });
	const taskRows = useTaskRows();
	const now = Date.now();

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<div className="ml-auto flex items-center gap-2.5">
					<SyncButton isSyncing={isSyncing} onClick={() => void syncAll()} />
				</div>
			</FeedHeader>

			<div className={TABLE_LIST}>
				{workConfig && !workConfig.hasDeterm && (
					<ConnectNotice
						provider="determ"
						text="Determ isn't connected - add an API token and the feeds to read."
					/>
				)}
				{feed.error?.data?.code === "UNAUTHORIZED" ? (
					<ConnectNotice
						provider="determ"
						text="Determ rejected the token - it was revoked or changed. Paste a new one."
					/>
				) : (
					<FeedError error={feed.error} />
				)}
				{feed.data && rows.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-muted-foreground">
						No new mentions this week
					</div>
				)}
				{rows.length > 0 && <TaskTableHeader />}
				{rows.map((row) => {
					const item = items.get(`determ:${row.id}`);
					return (
						item && (
							<TaskRow key={item.key} item={item} rows={taskRows} now={now} />
						)
					);
				})}
			</div>
		</div>
	);
}
