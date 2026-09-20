import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { useTabsStore } from "renderer/stores/tabs/store";
import { isValidCron, nextRun } from "shared/cron";
import {
	FEED_LIST,
	FEED_ROW,
	ROW_LIVE_BUTTON,
	ROW_META,
	ROW_PRIMARY_BUTTON,
	RowActions,
} from "../components/FeedChrome";
import { NEXT_RUN_FORMAT, TaskBox } from "../components/TaskBox";
import {
	type OdinTask,
	taskPrompt,
	taskText,
	useMyTasks,
} from "../hooks/useOdinTasks";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePendingFocus } from "../hooks/usePendingFocus";

export const Route = createFileRoute("/_authenticated/_odin/automations/")({
	component: AutomationsPage,
});

/**
 * The schedules people actually want, as a native `<datalist>` — suggestions
 * on an input that still takes any cron you type. A preset dropdown that
 * writes into a field is two widgets that can disagree; this is one.
 */
const PRESETS: [string, string][] = [
	["@hourly", "every hour, on the hour"],
	["0 9 * * 1-5", "weekdays at 09:00"],
	["0 9 * * *", "every day at 09:00"],
	["30 17 * * 5", "Fridays at 17:30"],
	["0 * * * *", "every hour"],
	["*/30 * * * *", "every 30 minutes"],
	["0 9 1 * *", "the 1st of the month at 09:00"],
];

const CRON_HELP =
	"minute hour day-of-month month day-of-week — e.g. 0 9 * * 1-5 for weekdays at 09:00. @hourly, @daily, @weekly and @monthly work too.";

/** The schedule field. Red while what's typed isn't a schedule. */
function CronInput({
	value,
	onChange,
	onCommit,
	className,
}: {
	value: string;
	onChange: (value: string) => void;
	onCommit?: () => void;
	className?: string;
}) {
	const bad = value.trim() !== "" && !isValidCron(value);
	return (
		<input
			value={value}
			list="odin-cron-presets"
			spellCheck={false}
			aria-label="Schedule"
			placeholder="0 9 * * 1-5"
			title={CRON_HELP}
			onChange={(event) => onChange(event.target.value)}
			onBlur={() => onCommit?.()}
			onKeyDown={(event) => {
				if (event.key === "Enter") onCommit?.();
			}}
			className={cn(
				"rounded-[7px] border bg-[#0a0a0c] px-2 py-1 font-mono text-[12px] text-[#f5f5f7] outline-none",
				bad ? "border-[#f0647a]" : "border-[#25252e] focus:border-[#f5b83d]",
				className,
			)}
		/>
	);
}

/**
 * Automations — the tasks that start themselves.
 *
 * Its own panel rather than another tab in the feed strip: every feed there
 * answers "what's waiting on me", and an automation is the opposite of that.
 * They still show up in My Tasks, marked amber with their schedule, so the
 * list you scan doesn't hide a job that's about to run on its own.
 *
 * ponytail: same localStorage store as My Tasks (an automation IS a task with
 * a cron), so nothing here needed a table, a migration or a sync path.
 */
function AutomationsPage() {
	const { automations, add, edit, remove, setCron, setPaused, setPane } =
		useMyTasks();
	const [draft, setDraft] = useState("");
	const [draftCron, setDraftCron] = useState("0 9 * * 1-5");
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editDraft, setEditDraft] = useState("");
	const [cronDraft, setCronDraft] = useState<{
		id: string;
		text: string;
	} | null>(null);
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching, launchingKey } = useLaunchTaskSession();
	const navigate = useNavigate();
	const panes = useTabsStore((s) => s.panes);

	/** The session this automation's last run started, while it's still open. */
	const livePaneId = (task: OdinTask) => {
		if (!task.paneId) return null;
		const pane = panes[task.paneId];
		return pane && !pane.completed ? pane.id : null;
	};

	/** The same launch the scheduler makes, off a button instead of the clock. */
	const runNow = async (task: OdinTask) => {
		const ensured = await ensureWorkspace();
		if (!ensured.ok) return toast.error(ensured.error);
		const result = await launch({
			key: task.id,
			workspaceId: ensured.workspace.id,
			title: task.title,
			description: task.notes || null,
			brief: taskPrompt(task),
			tags: ["automation"],
		});
		if (!result.ok) return toast.error(result.error);
		setPane(task.id, result.paneId);
		usePendingFocus.getState().focus(result.paneId);
		navigate({ to: "/board" });
	};

	const addAutomation = () => {
		if (!isValidCron(draftCron))
			return toast.error(`Not a schedule. ${CRON_HELP}`);
		add(draft, draftCron.trim());
		setDraft("");
	};

	return (
		<div className="flex h-full flex-col">
			{/* The presets every schedule field on this page offers. */}
			<datalist id="odin-cron-presets">
				{PRESETS.map(([expr, label]) => (
					<option key={expr} value={expr} label={label} />
				))}
			</datalist>

			<div className="flex items-center gap-2.5 border-b border-[#25252e] px-[18px] py-2.5">
				<span className="text-[13px] font-semibold text-[#f5f5f7]">
					Automations
				</span>
				<span className="text-[12px] text-[#8a8a97]">
					tasks that start themselves, on a cron — while Odin is open
				</span>
			</div>

			<div className="shrink-0 border-b border-[#25252e] px-[18px] py-3">
				{/* TaskBox is `h-full` so a dialog can stretch it. Left as a direct
				    child here it claims this whole block — schedule row included —
				    and its fields paint over the first automation below. Its own
				    auto-height wrapper is what makes `h-full` mean "as tall as the
				    box wants". */}
				<div>
					<TaskBox
						value={draft}
						// Priority says which task you'd do first. An automation has a
						// time instead — the schedule below is its whole answer.
						hidePriority
						placeholder="What should run on a schedule?"
						onChange={setDraft}
						onSubmit={addAutomation}
						onCancel={() => setDraft("")}
					/>
				</div>
				<div className="mt-2 flex items-center gap-2">
					<span className="text-[11px] text-[#8a8a97]">Schedule</span>
					<CronInput value={draftCron} onChange={setDraftCron} />
					<span className={ROW_META}>
						{isValidCron(draftCron)
							? `next ${nextRun(draftCron)?.toLocaleString(undefined, NEXT_RUN_FORMAT) ?? "— never fires"}`
							: "not a cron expression"}
					</span>
					<div className="flex-1" />
					<button
						type="button"
						onClick={addAutomation}
						className={ROW_PRIMARY_BUTTON}
					>
						Add automation
					</button>
				</div>
			</div>

			<div className={FEED_LIST}>
				{automations.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
						Nothing scheduled. Write the job above, give it a cron, and Odin
						starts the session for you.
					</div>
				)}
				{automations.map((task) => {
					const activePaneId = livePaneId(task);
					const next = task.paused ? null : nextRun(task.cron ?? "");
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
								// Amber left edge — the same mark the row carries in My
								// Tasks, so an automation reads the same in both places.
								"border-l-2 border-l-[#f5b83d]",
								task.paused && "border-l-[#3a3a46] opacity-60",
								activePaneId && "bg-[#0f1613]",
							)}
						>
							<div className="flex items-start gap-3">
								<div className="min-w-0 flex-1">
									<button
										type="button"
										title="Click to edit"
										onClick={() => {
											setEditDraft(taskText(task));
											setEditingId(task.id);
										}}
										className="w-full cursor-text text-left"
									>
										<span className="block truncate text-[13px] font-semibold text-[#f5f5f7]">
											{task.title}
										</span>
										{task.notes && (
											<span className="mt-1 block truncate text-[11.5px] text-[#a5a5b3]">
												{task.notes.replace(/\s+/g, " ")}
											</span>
										)}
									</button>
									<div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
										{/* The schedule is editable in place: changing when a job
										    runs is the whole point of this panel, and burying it
										    behind the task editor makes it the one thing you have
										    to reopen the task to do. */}
										<CronInput
											value={
												cronDraft?.id === task.id
													? cronDraft.text
													: (task.cron ?? "")
											}
											onChange={(text) => setCronDraft({ id: task.id, text })}
											onCommit={() => {
												if (!cronDraft || cronDraft.id !== task.id) return;
												const text = cronDraft.text.trim();
												setCronDraft(null);
												if (text === (task.cron ?? "")) return;
												if (!isValidCron(text)) {
													return toast.error(`Not a schedule. ${CRON_HELP}`);
												}
												setCron(task.id, text);
											}}
											className="w-[130px] py-[1px]"
										/>
										<span className={ROW_META}>
											{task.paused
												? "paused"
												: next
													? `next ${next.toLocaleString(undefined, NEXT_RUN_FORMAT)}`
													: "never fires"}
										</span>
										<span className={ROW_META}>
											{task.lastRunAt
												? `last ran ${new Date(task.lastRunAt).toLocaleString(
														undefined,
														{
															month: "short",
															day: "numeric",
															hour: "2-digit",
															minute: "2-digit",
														},
													)}`
												: "never run"}
										</span>
										{activePaneId && (
											<span className="inline-flex items-center gap-1 rounded-[5px] bg-[#14301f] px-[7px] py-[1px] font-semibold text-[#3ecf8e]">
												<span className="size-1.5 animate-pulse rounded-full bg-current" />
												session live
											</span>
										)}
									</div>
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									{/* Both, not either/or: the schedule starts a run whether
									    or not the last one is still open, so the button has no
									    business refusing to. */}
									{activePaneId && (
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
									)}
									<button
										type="button"
										disabled={isLaunching}
										onClick={() => void runNow(task)}
										className={ROW_PRIMARY_BUTTON}
									>
										{launchingKey === task.id ? "Starting…" : "Run now"}
									</button>
									{/* Pause stays visible: an automation you can only stop by
									    deleting it is one you retype next week. */}
									<button
										type="button"
										title={
											task.paused
												? "Resume — put it back on its schedule"
												: "Pause — keep it, stop running it"
										}
										onClick={() => setPaused(task.id, !task.paused)}
										className="shrink-0 rounded-[7px] px-2 py-1 text-xs font-semibold text-[#8a8a97] hover:bg-[#1f1f27] hover:text-[#f5f5f7]"
									>
										{task.paused ? "Resume" : "Pause"}
									</button>
									<RowActions>
										<button
											type="button"
											title="Delete this automation"
											onClick={() => remove(task.id)}
											className="rounded-[7px] px-2 py-1 text-xs font-semibold text-[#8a8a97] hover:bg-[#1f1f27] hover:text-[#f5f5f7]"
										>
											✕
										</button>
									</RowActions>
								</div>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
