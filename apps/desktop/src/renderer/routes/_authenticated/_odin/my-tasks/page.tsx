import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	TABLE_LIST,
	TaskRow,
	TaskTableHeader,
	useTaskRows,
} from "../all/TaskTable";
import { useFeedItems } from "../all/use-all-items";
import { FeedDivider, FeedHeader } from "../components/FeedChrome";
import { TaskBox } from "../components/TaskBox";
import { useDone } from "../hooks/useDone";
import { useMyTasks } from "../hooks/useOdinTasks";

export const Route = createFileRoute("/_authenticated/_odin/my-tasks/")({
	component: MyTasksPage,
});

/**
 * My Tasks - the one feed with no upstream system behind it. Jira, Slack and
 * PRs mirror other people's queues; this is where a task that isn't a ticket
 * yet gets written down, and started with an agent whenever you're ready.
 * Rows are All's table (TaskRow); a title opens the task in All's side panel,
 * where it's renamed and its brief edited.
 */
function MyTasksPage() {
	// Automations live on their own page; this list is only what waits on you.
	// Done or Reading material from All tasks is put away here too, the way
	// the tab's badge already counts it.
	const { todos, add } = useMyTasks();
	const { isDone } = useDone();
	const tasks = todos.filter((task) => !isDone({ key: `task:${task.id}` }));
	const items = useFeedItems({ tasks });
	const rows = useTaskRows();
	const now = Date.now();
	const [draft, setDraft] = useState("");
	const [draftRepo, setDraftRepo] = useState("");
	const { data: skills } = electronTrpc.skills.list.useQuery();
	const { data: docs } = electronTrpc.system.listDocs.useQuery();
	const { data: repos } = electronTrpc.repos.list.useQuery();

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<FeedDivider />
				<span className="shrink-0 text-[12px] text-muted-foreground">
					my own list · start a session when you're ready
				</span>
			</FeedHeader>

			<div className="border-b border-border px-[18px] py-2">
				<TaskBox
					compact
					value={draft}
					skills={skills}
					docs={docs}
					repos={repos}
					repo={draftRepo}
					onRepoChange={setDraftRepo}
					placeholder="What needs doing?"
					onChange={setDraft}
					onSubmit={() => {
						add(draft, undefined, draftRepo);
						setDraft("");
						setDraftRepo("");
					}}
					onCancel={() => setDraft("")}
					submitLabel="Add task"
				/>
			</div>

			<div className={TABLE_LIST}>
				{tasks.length === 0 ? (
					<div className="px-2 py-8 text-center text-xs text-muted-foreground">
						Nothing on your list - type it in above.
					</div>
				) : (
					<TaskTableHeader date="Created" />
				)}
				{tasks.map((task) => {
					const item = items.get(`task:${task.id}`);
					return (
						item && (
							<TaskRow
								key={item.key}
								item={item}
								rows={rows}
								now={now}
								created
							/>
						)
					);
				})}
			</div>
		</div>
	);
}
