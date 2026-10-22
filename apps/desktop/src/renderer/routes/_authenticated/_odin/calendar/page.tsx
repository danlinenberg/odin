import { createFileRoute } from "@tanstack/react-router";
import { ConnectNotice } from "renderer/components/ConnectProvider/ConnectProvider";
import { upcomingMeetings } from "../all/all-items";
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

export const Route = createFileRoute("/_authenticated/_odin/calendar/")({
	component: CalendarPage,
});

/**
 * Meetings from now to the end of tomorrow, soonest first - each one a thing
 * to prepare for. Read-only: Open joins the call, Done takes the meeting out
 * of Odin (not the calendar), and Start session preps it from the agenda.
 */
function CalendarPage() {
	const { meetings, workConfig, syncAll, isSyncing } = useOdinFeeds();
	const { isDone } = useDone();
	const now = Date.now();
	const rows = upcomingMeetings(meetings.data?.meetings ?? [], now).filter(
		(meeting) =>
			!isDone({ key: `meeting:${meeting.id}`, url: meeting.joinUrl }),
	);
	const items = useFeedItems({ meetings: rows });
	const taskRows = useTaskRows();

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<div className="ml-auto flex items-center gap-2.5">
					<SyncButton isSyncing={isSyncing} onClick={() => void syncAll()} />
				</div>
			</FeedHeader>

			<div className={TABLE_LIST}>
				{workConfig && !workConfig.hasCalendar && (
					<ConnectNotice
						provider="calendar"
						text="Your calendar isn't connected - connect it to see today's and tomorrow's meetings."
					/>
				)}
				{meetings.error?.data?.code === "UNAUTHORIZED" ? (
					<ConnectNotice
						provider="calendar"
						text="The calendar refused its address - it was reset or removed. Paste the new one."
					/>
				) : (
					<FeedError error={meetings.error} />
				)}
				{meetings.data && rows.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-muted-foreground">
						No more meetings today or tomorrow 🎉
					</div>
				)}
				{rows.length > 0 && <TaskTableHeader date="When" />}
				{rows.map((meeting) => {
					const item = items.get(`meeting:${meeting.id}`);
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
