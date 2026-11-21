import { Button } from "@odin/ui/button";
import { toast } from "@odin/ui/sonner";
import { Textarea } from "@odin/ui/textarea";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ConnectNotice } from "renderer/components/ConnectProvider/ConnectProvider";
import { electronTrpc } from "renderer/lib/electron-trpc";
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
	const views = electronTrpc.connections.airtableViews.useQuery(undefined, {
		enabled: workConfig?.hasAirtable === true,
	});
	const [editing, setEditing] = useState(false);
	const noViews = views.data?.links.length === 0;

	// Ticked rows, for acting on many at once - the same bar as All's.
	const ticks = useBulkTicks(
		rows.flatMap((row) => items.get(`airtable:${row.id}`) ?? []),
		taskRows,
	);
	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<div className="ml-auto flex items-center gap-2.5">
					{workConfig?.hasAirtable && (
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setEditing((open) => !open)}
						>
							Views
						</Button>
					)}
					<SyncButton isSyncing={isSyncing} onClick={() => void syncAll()} />
				</div>
			</FeedHeader>

			<div className={TABLE_LIST}>
				{workConfig && !workConfig.hasAirtable && (
					<ConnectNotice
						provider="airtable"
						text="Airtable isn't connected - sign in, then paste the views to read."
					/>
				)}
				{workConfig?.hasAirtable && (editing || noViews) && views.data && (
					<AirtableViews
						links={views.data.links}
						onSaved={() => {
							setEditing(false);
							void views.refetch();
							void feed.refetch();
						}}
					/>
				)}
				{feed.error?.data?.code === "UNAUTHORIZED" ? (
					<ConnectNotice
						provider="airtable"
						text="Airtable signed Odin out - sign in again."
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
				{ticks.bar}
				{rows.map((row) => {
					const item = items.get(`airtable:${row.id}`);
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

/** The view links whose records are this feed, one per line. */
function AirtableViews({
	links,
	onSaved,
}: {
	links: string[];
	onSaved: () => void;
}) {
	const [text, setText] = useState(links.join("\n"));
	useEffect(() => setText(links.join("\n")), [links]);
	const save = electronTrpc.connections.saveAirtableViews.useMutation({
		onSuccess: onSaved,
		onError: (error) => toast.error(error.message),
	});
	return (
		<div className="space-y-2 px-2 py-3">
			<p className="text-xs text-muted-foreground">
				One view link per line, copied from the address bar
				(airtable.com/app…/tbl…/viw…). Every record in the view shows, so filter
				it to your own open tasks in Airtable.
			</p>
			<Textarea
				value={text}
				placeholder="https://airtable.com/app…/tbl…/viw…"
				onChange={(event) => setText(event.target.value)}
			/>
			<Button
				size="sm"
				disabled={save.isPending}
				onClick={() => save.mutate({ links: text.split("\n") })}
			>
				Save views
			</Button>
		</div>
	);
}
