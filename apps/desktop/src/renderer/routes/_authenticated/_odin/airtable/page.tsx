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

export const Route = createFileRoute("/_authenticated/_odin/airtable/")({
	component: AirtablePage,
});

/**
 * The records in the Airtable views linked in Settings → Connections. Open takes you to the record. Done takes the row out of Odin only.
 */
function AirtablePage() {
	const { airtable: feed, workConfig, syncAll, isSyncing } = useOdinFeeds();
	const { isDone } = useDone();
	const rows = (feed.data?.records ?? []).filter(
		(row) => !isDone({ key: `airtable:${row.id}`, url: row.url }),
	);
	const items = useFeedItems({ airtable: rows });
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
				{workConfig && !workConfig.hasAirtable && (
					<ConnectNotice
						provider="airtable"
						text="Airtable isn't connected - add a token and the views to read."
					/>
				)}
				{feed.error?.data?.code === "UNAUTHORIZED" ? (
					<ConnectNotice
						provider="airtable"
						text="Airtable rejected the token - it was revoked or changed. Paste a new one."
					/>
				) : (
					<FeedError error={feed.error} />
				)}
				{feed.data && rows.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-muted-foreground">
						No records in your Airtable views 🎉
					</div>
				)}
				{rows.length > 0 && <TaskTableHeader />}
				{rows.map((row) => {
					const item = items.get(`airtable:${row.id}`);
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
