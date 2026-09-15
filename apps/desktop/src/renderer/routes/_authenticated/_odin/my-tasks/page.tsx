import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { useTabsStore } from "renderer/stores/tabs/store";
import {
	FEED_LIST,
	FEED_ROW,
	FeedDivider,
	FeedHeader,
	ROW_LIVE_BUTTON,
	ROW_META,
	ROW_PRIMARY_BUTTON,
	RowActions,
} from "../components/FeedChrome";
import { PriorityChip, TaskBox } from "../components/TaskBox";
import {
	type OdinTask,
	taskPrompt,
	taskText,
	useMyTasks,
} from "../hooks/useOdinTasks";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePendingFocus } from "../hooks/usePendingFocus";

export const Route = createFileRoute("/_authenticated/_odin/my-tasks/")({
	component: MyTasksPage,
});

/**
 * My Tasks — the one feed with no upstream system behind it. Jira, Slack and
 * PRs mirror other people's queues; this is where a task that isn't a ticket
 * yet gets written down, and started with an agent whenever you're ready.
 *
 * ponytail: localStorage (useOdinTasks), not the app DB — a personal todo list
 * that only this renderer reads doesn't need a migration. Move it if it ever
 * has to be visible from outside the app.
 */

function MyTasksPage() {
	const { tasks, add, edit, remove, setPane } = useMyTasks();
	const [draft, setDraft] = useState("");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editDraft, setEditDraft] = useState("");
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching, launchingKey } = useLaunchTaskSession();
	const navigate = useNavigate();
	const panes = useTabsStore((s) => s.panes);

	/** The session this task started, while it's still on the board. */
	const livePaneId = (task: OdinTask) => {
		if (!task.paneId) return null;
		const pane = panes[task.paneId];
		return pane && !pane.completed ? pane.id : null;
	};

	const handleStart = async (task: OdinTask) => {
		const ensured = await ensureWorkspace();
		if (!ensured.ok) return toast.error(ensured.error);
		const result = await launch({
			key: task.id,
			workspaceId: ensured.workspace.id,
			title: task.title,
			description: task.notes || null,
			brief: taskPrompt(task),
		});
		if (!result.ok) return toast.error(result.error);
		// The task keeps its row and gains a way into the session — starting one
		// isn't finishing it, so it's still yours to ✕ when it's actually done.
		setPane(task.id, result.paneId);
		usePendingFocus.getState().focus(result.paneId);
		navigate({ to: "/board" });
	};

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<FeedDivider />
				<span className="shrink-0 text-[12px] text-[#8a8a97]">
					my own list · start a session when you're ready
				</span>
			</FeedHeader>

			<div className="border-b border-[#25252e] px-[18px] py-3">
				<TaskBox
					value={draft}
					placeholder="What needs doing?"
					onChange={setDraft}
					onSubmit={() => {
						add(draft);
						setDraft("");
					}}
					onCancel={() => setDraft("")}
				/>
			</div>

			<div className={FEED_LIST}>
				{tasks.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
						Nothing on your list — type it in above.
					</div>
				)}
				{tasks.map((task) => {
					const activePaneId = livePaneId(task);
					if (editingId === task.id) {
						return (
							<TaskBox
								key={task.id}
								value={editDraft}
								autoFocus
								onChange={setEditDraft}
								onSubmit={() => {
									edit(task.id, editDraft);
									setEditingId(null);
								}}
								onCancel={() => setEditingId(null)}
							/>
						);
					}
					return (
						<div
							key={task.id}
							className={cn(
								FEED_ROW,
								activePaneId &&
									"border-[#1a4029] border-l-2 border-l-[#3ecf8e] bg-[#0f1613]",
							)}
						>
							<div className="flex items-start gap-3">
								<button
									type="button"
									title="Click to edit"
									onClick={() => {
										setEditDraft(taskText(task));
										setEditingId(task.id);
									}}
									className="min-w-0 flex-1 cursor-text text-left"
								>
									<span className="block truncate text-[13px] font-semibold text-[#f5f5f7]">
										{task.title}
									</span>
									{task.notes && (
										<span className="mt-1 block truncate text-[11.5px] text-[#a5a5b3]">
											{task.notes.replace(/\s+/g, " ")}
										</span>
									)}
									<span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
										<PriorityChip priority={task.priority} />
										{activePaneId && (
											<span className="inline-flex items-center gap-1 rounded-[5px] bg-[#14301f] px-[7px] py-[1px] font-semibold text-[#3ecf8e]">
												<span className="size-1.5 animate-pulse rounded-full bg-current" />
												session live
											</span>
										)}
										<span className={ROW_META}>
											{new Date(task.createdAt).toLocaleDateString(undefined, {
												month: "short",
												day: "numeric",
											})}
										</span>
									</span>
								</button>
								<div className="flex shrink-0 items-center gap-1.5">
									<RowActions>
										<button
											type="button"
											title="Delete this task"
											onClick={() => remove(task.id)}
											className="rounded-[7px] px-2 py-1 text-xs font-semibold text-[#8a8a97] hover:bg-[#1f1f27] hover:text-[#f5f5f7]"
										>
											✕
										</button>
									</RowActions>
									{activePaneId ? (
										<button
											type="button"
											onClick={() => {
												usePendingFocus.getState().focus(activePaneId);
												navigate({ to: "/board" });
											}}
											className={ROW_LIVE_BUTTON}
										>
											Go to session →
										</button>
									) : (
										<button
											type="button"
											disabled={isLaunching}
											onClick={() => void handleStart(task)}
											className={ROW_PRIMARY_BUTTON}
										>
											{launchingKey === task.id ? "Starting…" : "Start session"}
										</button>
									)}
								</div>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
