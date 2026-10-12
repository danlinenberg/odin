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

export const Route = createFileRoute("/_authenticated/_odin/clickup/")({
	component: ClickupPage,
});

/**
 * Open ClickUp tasks assigned to me. Read-only: Open takes you to the task,
 * Done takes the row out of Odin (not ClickUp).
 */
function ClickupPage() {
	const { clickup, workConfig, syncAll, isSyncing } = useOdinFeeds();
	const { isDone } = useDone();
	const rows = (clickup.data?.tasks ?? []).filter(
		(task) => !isDone({ key: `clickup:${task.id}`, url: task.url }),
	);
	const items = useFeedItems({ clickup: rows });
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
				{workConfig && !workConfig.hasClickup && (
					<ConnectNotice
						provider="clickup"
						text="ClickUp isn't connected - add a personal token to see your tasks."
					/>
				)}
				{clickup.error?.data?.code === "UNAUTHORIZED" ? (
					<ConnectNotice
						provider="clickup"
						text="ClickUp rejected the token - it was revoked or changed. Paste a new one."
					/>
				) : (
					<FeedError error={clickup.error} />
				)}
				{clickup.data && rows.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-muted-foreground">
						No open ClickUp tasks 🎉
					</div>
				)}
				{rows.length > 0 && <TaskTableHeader />}
				{rows.map((task) => {
					const item = items.get(`clickup:${task.id}`);
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
