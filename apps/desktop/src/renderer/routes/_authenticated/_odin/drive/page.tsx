import { createFileRoute } from "@tanstack/react-router";
import { ConnectNotice } from "renderer/components/ConnectProvider/ConnectProvider";
import { useBulkTicks } from "../all/BulkBar";
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

export const Route = createFileRoute("/_authenticated/_odin/drive/")({
	component: DrivePage,
});

/**
 * Google Drive files shared with me in the last 14 days, newest share first.
 * Open takes you to the file; Done only takes the row out of Odin.
 */
function DrivePage() {
	const { drive, workConfig, syncAll, isSyncing } = useOdinFeeds();
	const { isDone } = useDone();
	const rows = (drive.data?.files ?? []).filter(
		(file) => !isDone({ key: `drive:${file.id}`, url: file.url }),
	);
	const items = useFeedItems({ drive: rows });
	const taskRows = useTaskRows();
	const now = Date.now();

	// Ticked rows, for acting on many at once - the same bar as All's.
	const ticks = useBulkTicks(
		rows.flatMap((file) => items.get(`drive:${file.id}`) ?? []),
		taskRows,
	);
	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<div className="ml-auto flex items-center gap-2.5">
					<SyncButton isSyncing={isSyncing} onClick={() => void syncAll()} />
				</div>
			</FeedHeader>

			<div className={TABLE_LIST}>
				{workConfig && !workConfig.hasDrive && (
					<ConnectNotice
						provider="gmail"
						text="This tab lists the files Google Drive emailed you about sharing. Connect Gmail to see them."
					/>
				)}
				{drive.error?.data?.code === "UNAUTHORIZED" ? (
					<ConnectNotice
						provider="gmail"
						text="Gmail rejected the app password - connect Gmail again."
					/>
				) : (
					<FeedError error={drive.error} />
				)}
				{drive.data && rows.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-muted-foreground">
						Nothing shared with you in the last 14 days
					</div>
				)}
				{rows.length > 0 && <TaskTableHeader />}
				{ticks.bar}
				{rows.map((file) => {
					const item = items.get(`drive:${file.id}`);
					return (
						item && (
							<TaskRow
								{...ticks.rowProps(item)}
								key={item.key}
								item={item}
								rows={taskRows}
								now={now}
							/>
						)
					);
				})}
			</div>
		</div>
	);
}
