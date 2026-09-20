import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import {
	cronOf,
	DEFAULT_SCHEDULE,
	isValidCron,
	nextRun,
	type Repeat,
	SHORT_DAYS,
	scheduleOf,
	WEEKDAY_NAMES,
} from "shared/cron";
import {
	FEED_LIST,
	FEED_ROW,
	ROW_LIVE_BUTTON,
	ROW_META,
	ROW_PRIMARY_BUTTON,
	RowActions,
} from "../components/FeedChrome";
import { NEXT_RUN_FORMAT, SkillChip, TaskBox } from "../components/TaskBox";
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

const CRON_HELP =
	"minute hour day-of-month month day-of-week — e.g. 0 9 * * 1-5 for weekdays at 09:00.";

/** What the Repeat menu offers, in order. */
const REPEATS: [Repeat, string][] = [
	["15m", "Every 15 minutes"],
	["30m", "Every 30 minutes"],
	["hourly", "Every hour"],
	["daily", "Every day"],
	// One entry, not "Every weekday" and "Every week": both were the same
	// schedule with a different number of days ticked, and two menu entries for
	// one thing is two places for it to disagree. It opens on Mon-Fri, so the
	// common case is still no clicks.
	["days", "On certain days"],
	["monthly", "Every month"],
];

const FIELD =
	"cursor-pointer rounded-[6px] bg-[#1f1f27] px-1.5 py-[3px] text-[11px] font-semibold text-[#a5a5b3] outline-none transition-colors hover:text-[#f5f5f7] focus:text-[#f5f5f7]";

/**
 * When a job runs, said in the terms people think in — a repeat, a day, a
 * time. Cron is still what's stored and matched; nobody has to write one.
 *
 * ponytail: native `<select>`s and `<input type="time">`. The time picker,
 * its keyboard handling and its locale (12h or 24h) all come free, and there
 * is no popup to style. The fields hold no state of their own either — they
 * read the cron and write a new one, so what's shown and what runs can't
 * drift apart.
 *
 * Anything the menu can't express (`0 9 * * 1,3,5`) stays a cron: the Custom
 * entry shows it verbatim in a text field rather than rounding it to the
 * nearest preset.
 */
function ScheduleFields({
	cron,
	onChange,
}: {
	cron: string;
	onChange: (cron: string) => void;
}) {
	// Custom is sticky once chosen, so picking it doesn't immediately snap back
	// on a cron the menu happens to be able to express.
	const [wantsCustom, setWantsCustom] = useState(false);
	const [draft, setDraft] = useState<string | null>(null);
	const parsed = scheduleOf(cron);
	const schedule = parsed ?? DEFAULT_SCHEDULE;
	const custom = wantsCustom || !parsed;
	const set = (patch: Partial<typeof schedule>) =>
		onChange(cronOf({ ...schedule, ...patch }));

	const text = draft ?? cron;
	const commit = () => {
		setDraft(null);
		const next = text.trim();
		if (next === cron) return;
		if (!isValidCron(next)) return toast.error(`Not a schedule. ${CRON_HELP}`);
		onChange(next);
	};

	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<select
				aria-label="Repeat"
				value={custom ? "custom" : schedule.repeat}
				onChange={(event) => {
					const value = event.target.value;
					setWantsCustom(value === "custom");
					if (value !== "custom") set({ repeat: value as Repeat });
				}}
				className={FIELD}
			>
				{REPEATS.map(([value, label]) => (
					<option key={value} value={value}>
						{label}
					</option>
				))}
				<option value="custom">Custom cron…</option>
			</select>

			{custom ? (
				<input
					value={text}
					spellCheck={false}
					aria-label="Cron expression"
					placeholder="0 9 * * 1-5"
					title={CRON_HELP}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") commit();
					}}
					className={cn(
						"w-[124px] rounded-[6px] border bg-[#0a0a0c] px-2 py-[2px] font-mono text-[11px] text-[#f5f5f7] outline-none",
						text.trim() && !isValidCron(text)
							? "border-[#f0647a]"
							: "border-[#25252e] focus:border-[#f5b83d]",
					)}
				/>
			) : (
				<>
					{schedule.repeat === "days" && (
						/* Seven toggles rather than a multi-select: which days are on is
						   the answer, and a row of them shows it without opening
						   anything. */
						<span className="flex items-center gap-[3px]">
							{SHORT_DAYS.map((name, index) => {
								const on = schedule.weekdays.includes(index);
								return (
									<button
										key={name}
										type="button"
										aria-label={WEEKDAY_NAMES[index]}
										aria-pressed={on}
										// Turning the last one off would leave a schedule that
										// never fires and no way back except Custom, so the last
										// lit day stays lit.
										onClick={() =>
											set({
												weekdays: on
													? schedule.weekdays.filter((d) => d !== index)
													: [...schedule.weekdays, index],
											})
										}
										disabled={on && schedule.weekdays.length === 1}
										className={cn(
											"rounded-[5px] px-[5px] py-[3px] text-[11px] font-semibold transition-colors",
											on
												? "bg-[#2e2413] text-[#f5b83d]"
												: "bg-[#1f1f27] text-[#6f6f7d] hover:text-[#a5a5b3]",
										)}
									>
										{name}
									</button>
								);
							})}
						</span>
					)}
					{schedule.repeat === "monthly" && (
						<select
							aria-label="Day of the month"
							// 1–28 only: the 29th-31st don't happen every month, and a
							// job that skips February isn't a monthly job.
							value={schedule.day}
							onChange={(event) => set({ day: Number(event.target.value) })}
							className={FIELD}
						>
							{Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
								<option key={day} value={day}>
									Day {day}
								</option>
							))}
						</select>
					)}
					{schedule.repeat !== "15m" &&
						schedule.repeat !== "30m" &&
						schedule.repeat !== "hourly" && (
							<>
								<span className="text-[11px] text-[#8a8a97]">at</span>
								<input
									type="time"
									aria-label="Time"
									value={schedule.time}
									onChange={(event) => set({ time: event.target.value })}
									// color-scheme: the native clock icon and its popup are
									// drawn by Chromium, and default to a white-on-white
									// widget on this dark bar without it.
									className={cn(FIELD, "[color-scheme:dark]")}
								/>
							</>
						)}
				</>
			)}
		</div>
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
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, isLaunching, launchingKey } = useLaunchTaskSession();
	const navigate = useNavigate();
	const panes = useTabsStore((s) => s.panes);
	// The agent's own skills, for the compose box and every edit box below.
	const { data: skills } = electronTrpc.skills.list.useQuery();

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
			skill: task.skill,
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
						skills={skills}
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
					<span className="text-[11px] text-[#8a8a97]">Repeat</span>
					<ScheduleFields cron={draftCron} onChange={setDraftCron} />
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
								skills={skills}
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
										{/* Editable in place: changing when a job runs is the whole
										    point of this panel, and burying it behind the task
										    editor makes it the one thing you have to reopen the
										    task to do. */}
										<ScheduleFields
											cron={task.cron ?? ""}
											onChange={(next) => setCron(task.id, next)}
										/>
										{task.skill && <SkillChip skill={task.skill} />}
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
