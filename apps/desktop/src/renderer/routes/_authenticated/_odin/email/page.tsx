import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ConnectNotice } from "renderer/components/ConnectProvider/ConnectProvider";
import {
	TABLE_LIST,
	TaskRow,
	TaskTableHeader,
	useTaskRows,
} from "../all/TaskTable";
import { useFeedItems } from "../all/use-all-items";
import {
	FeedDivider,
	FeedHeader,
	FilterPill,
	SyncButton,
} from "../components/FeedChrome";
import { FeedError } from "../components/FeedError";
import { useDone } from "../hooks/useDone";
import { useOdinFeeds } from "../hooks/useOdinFeeds";

export const Route = createFileRoute("/_authenticated/_odin/email/")({
	component: EmailPage,
});

/**
 * Gmail inbox mail (unread when first seen; it stays after you open it until Done), junk (the model's call, and every invite, RSVP or cancellation) hidden until "All". Read-only:
 * Open takes you to the thread, Done takes the row out of Odin (not Gmail).
 */
function EmailPage() {
	const { emails, workConfig, syncAll, isSyncing } = useOdinFeeds();
	const { isDone } = useDone();
	const [showJunk, setShowJunk] = useState(false);
	const open = (emails.data?.emails ?? []).filter(
		(email) => !isDone({ key: `email:${email.id}`, url: email.url }),
	);
	const junkCount = open.filter((email) => email.junk === true).length;
	const rows = showJunk ? open : open.filter((email) => email.junk !== true);
	const items = useFeedItems({ emails: open });
	const taskRows = useTaskRows();
	const now = Date.now();

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<FeedDivider />
				<FilterPill
					active={!showJunk}
					count={open.length - junkCount}
					onClick={() => setShowJunk(false)}
				>
					Interesting
				</FilterPill>
				<FilterPill
					active={showJunk}
					count={open.length}
					onClick={() => setShowJunk(true)}
				>
					All
				</FilterPill>
				<div className="ml-auto flex items-center gap-2.5">
					<SyncButton isSyncing={isSyncing} onClick={() => void syncAll()} />
				</div>
			</FeedHeader>

			<div className={TABLE_LIST}>
				{workConfig && !workConfig.hasGmail && (
					<ConnectNotice
						provider="gmail"
						text="Gmail isn't connected - add an app password to see your unread mail."
					/>
				)}
				{/* A dead app password is fixed right here, not in Settings: paste a
				    new one and the feed refetches. */}
				{emails.error?.data?.code === "UNAUTHORIZED" ? (
					<ConnectNotice
						provider="gmail"
						text="Gmail rejected the app password - it was revoked or changed. Paste a new one."
					/>
				) : (
					<FeedError error={emails.error} />
				)}
				{emails.data && rows.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-muted-foreground">
						{junkCount > 0 && !showJunk
							? `Nothing interesting - ${junkCount} junk hidden`
							: "No unread mail 🎉"}
					</div>
				)}
				{rows.length > 0 && <TaskTableHeader date="Received" />}
				{rows.map((email) => {
					const item = items.get(`email:${email.id}`);
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
