import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { type OdinRule, useOdinRules } from "renderer/stores/odin-rules";
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
import { matchRepos, repoLabel } from "../components/repo-picker";
import {
	BuiltinChip,
	NEXT_RUN_FORMAT,
	SkillChip,
	TaskBox,
} from "../components/TaskBox";
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

const HOURS = Array.from({ length: 24 }, (_, hour) =>
	String(hour).padStart(2, "0"),
);

/**
 * ponytail: five-minute steps — twelve entries you can see at once instead of
 * sixty you scroll. A schedule already on an odd minute keeps it (below), and
 * Custom cron is the way to set a new one.
 */
const MINUTES = Array.from({ length: 12 }, (_, i) =>
	String(i * 5).padStart(2, "0"),
);

/**
 * The hour and the minute, as two menus.
 *
 * Not `<input type="time">`: Chromium draws that popup itself — a tall
 * blue-highlighted spinner that ignores the palette and can't be styled, which
 * is a jarring thing to hit in the middle of a dark toolbar. Two selects are
 * the same two numbers, in the app's own clothes, and they open as the
 * platform's ordinary menu like every other field on this row.
 */
function TimeFields({
	time,
	onChange,
}: {
	time: string;
	onChange: (time: string) => void;
}) {
	const [hh = "09", mm = "00"] = time.split(":");
	return (
		<span className="flex items-center gap-[3px]">
			<select
				aria-label="Hour"
				value={hh}
				onChange={(event) => onChange(`${event.target.value}:${mm}`)}
				className={FIELD}
			>
				{HOURS.map((hour) => (
					<option key={hour} value={hour}>
						{hour}
					</option>
				))}
			</select>
			<span className="text-[11px] text-[#8a8a97]">:</span>
			<select
				aria-label="Minute"
				value={mm}
				onChange={(event) => onChange(`${hh}:${event.target.value}`)}
				className={FIELD}
			>
				{/* A cron already set to :07 by hand keeps it rather than snapping
				    to the nearest five minutes the moment the menu is drawn. */}
				{!MINUTES.includes(mm) && <option value={mm}>{mm}</option>}
				{MINUTES.map((minute) => (
					<option key={minute} value={minute}>
						{minute}
					</option>
				))}
			</select>
		</span>
	);
}

/**
 * When a job runs, said in the terms people think in — a repeat, a day, a
 * time. Cron is still what's stored and matched; nobody has to write one.
 *
 * ponytail: plain `<select>`s throughout. The fields hold no state of their
 * own — they read the cron and write a new one, so what's shown and what runs
 * can't drift apart.
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
												: // #8a8a97, not the dimmer #6f6f7d: an unpicked day
													// still has to be readable (odin-palette-contrast).
													"bg-[#1f1f27] text-[#8a8a97] hover:text-[#f5f5f7]",
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
								<TimeFields
									time={schedule.time}
									onChange={(time) => set({ time })}
								/>
							</>
						)}
				</>
			)}
		</div>
	);
}

const RULE_INPUT =
	"min-w-0 flex-1 rounded-[6px] border border-[#25252e] bg-[#0a0a0c] px-2 py-1 text-[12px] text-[#f5f5f7] outline-none placeholder:text-[#6f6f7d] focus:border-[#f5b83d]";

/** Every skill as "/name", for the Do field's suggestions. */
function SkillOptions({ id }: { id: string }) {
	const { data: skills } = electronTrpc.skills.list.useQuery();
	return (
		<datalist id={id}>
			{skills?.map((skill) => (
				<option key={skill.name} value={`run /${skill.name}`}>
					{skill.description}
				</option>
			))}
		</datalist>
	);
}

/** "in" / "not in" — whether the repo beside it is the only one or the one left out. */
function RepoModeToggle({
	exclude,
	onChange,
}: {
	exclude: boolean;
	onChange: (exclude: boolean) => void;
}) {
	return (
		<button
			type="button"
			title={
				exclude
					? "Every repo except this one — click for only this repo"
					: "Only this repo — click for every repo except it"
			}
			onClick={() => onChange(!exclude)}
			className={cn(
				"shrink-0 rounded-[6px] px-1.5 py-[2px] text-[11px] font-semibold hover:bg-[#1f1f27]",
				exclude ? "text-[#f0647a]" : "text-[#8a8a97]",
			)}
		>
			{exclude ? "not in" : "in"}
		</button>
	);
}

/**
 * Which repo a rule is pinned to — blank leaves it on every session.
 * Type any part of the path to search the checkouts; it resolves on blur, the
 * same way the new-session dialog's repo field does (`matchRepos`).
 * ponytail: native <datalist> — Chromium does the search-as-you-type popup.
 */
function RepoSelect({
	value,
	onChange,
}: {
	value: string;
	onChange: (repo: string) => void;
}) {
	const { data: repos = [] } = electronTrpc.repos.list.useQuery();
	const listId = useId();
	const [draft, setDraft] = useState(value && repoLabel(value));
	// The add row clears its repo after adding; the field has to follow.
	useEffect(() => setDraft(value && repoLabel(value)), [value]);
	const hits = matchRepos(repos, draft);
	const commit = () => {
		if (!draft.trim()) return value && onChange("");
		// Untouched — keep it, even if that checkout has since left the list.
		if (value && draft === repoLabel(value)) return;
		const repo = hits.length === 1 ? (hits[0] as string) : null;
		if (!repo) {
			toast.error(
				hits.length > 1
					? `"${draft}" matches ${hits.length} repos — type more of the path.`
					: `No repo matches "${draft}".`,
			);
			setDraft(value && repoLabel(value));
			return;
		}
		setDraft(repoLabel(repo));
		if (repo !== value) onChange(repo);
	};
	return (
		<>
			<input
				aria-label="Repo"
				list={listId}
				value={draft}
				placeholder="any repo"
				title={value || "Every session, whatever repo it's in"}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
				}}
				className={cn(RULE_INPUT, "max-w-[200px]")}
			/>
			<datalist id={listId}>
				{repos.map((path) => (
					<option key={path} value={path}>
						{repoLabel(path)}
					</option>
				))}
			</datalist>
		</>
	);
}

/**
 * One rule, edited in place. The fields hold a draft and write it back on
 * blur, so typing doesn't rewrite localStorage on every keystroke.
 */
function RuleRow({ rule }: { rule: OdinRule }) {
	const { update, remove } = useOdinRules();
	const [when, setWhen] = useState(rule.when);
	const [action, setAction] = useState(rule.action);
	// Emptying a field would leave a rule that says nothing; put it back.
	const commit = () => {
		if (!when.trim() || !action.trim()) {
			setWhen(rule.when);
			setAction(rule.action);
			return;
		}
		if (when.trim() !== rule.when || action.trim() !== rule.action)
			update(rule.id, { when: when.trim(), action: action.trim() });
	};
	return (
		<div
			className={cn(
				FEED_ROW,
				"flex items-center gap-2 border-l-2 border-l-[#f5b83d]",
				rule.paused && "border-l-[#3a3a46] opacity-60",
			)}
		>
			<span className="text-[11px] text-[#8a8a97]">When</span>
			<input
				aria-label="When"
				value={when}
				onChange={(event) => setWhen(event.target.value)}
				onBlur={commit}
				className={RULE_INPUT}
			/>
			<span className="text-[11px] text-[#8a8a97]">do</span>
			<input
				aria-label="Do"
				list="odin-rule-skills"
				value={action}
				onChange={(event) => setAction(event.target.value)}
				onBlur={commit}
				className={RULE_INPUT}
			/>
			<RepoModeToggle
				exclude={!!rule.exclude}
				onChange={(exclude) =>
					update(rule.id, { exclude: exclude || undefined })
				}
			/>
			<RepoSelect
				value={rule.repo ?? ""}
				onChange={(repo) => update(rule.id, { repo: repo || undefined })}
			/>
			<button
				type="button"
				title={
					rule.paused
						? "Resume — hand it to new sessions again"
						: "Pause — keep it, stop handing it out"
				}
				onClick={() => update(rule.id, { paused: !rule.paused })}
				className="shrink-0 rounded-[7px] px-2 py-1 text-xs font-semibold text-[#8a8a97] hover:bg-[#1f1f27] hover:text-[#f5f5f7]"
			>
				{rule.paused ? "Resume" : "Pause"}
			</button>
			<RowActions>
				<button
					type="button"
					title="Delete this rule"
					onClick={() => remove(rule.id)}
					className="rounded-[7px] px-2 py-1 text-xs font-semibold text-[#8a8a97] hover:bg-[#1f1f27] hover:text-[#f5f5f7]"
				>
					✕
				</button>
			</RowActions>
		</div>
	);
}

/**
 * Rules — what an agent does when something comes up, rather than at a time.
 * Each one rides in the launch prompt of every session Odin starts from here
 * on; a session already running, or one you resume, has the prompt it had.
 */
function RulesPanel() {
	const { rules, add } = useOdinRules();
	const [when, setWhen] = useState("");
	const [action, setAction] = useState("");
	const [repo, setRepo] = useState("");
	const [exclude, setExclude] = useState(false);
	const submit = () => {
		if (!when.trim() || !action.trim())
			return toast.error("A rule needs both a when and a do.");
		add(when, action, repo, exclude);
		setWhen("");
		setAction("");
		setRepo("");
		setExclude(false);
	};
	const onEnter = (event: React.KeyboardEvent) => {
		if (event.key === "Enter") submit();
	};
	return (
		<>
			<SkillOptions id="odin-rule-skills" />
			<div className="flex shrink-0 items-center gap-2 border-b border-[#25252e] px-[18px] py-3">
				<span className="text-[11px] text-[#8a8a97]">When</span>
				<input
					aria-label="When"
					value={when}
					placeholder="you open a pull request"
					onChange={(event) => setWhen(event.target.value)}
					onKeyDown={onEnter}
					className={RULE_INPUT}
				/>
				<span className="text-[11px] text-[#8a8a97]">do</span>
				<input
					aria-label="Do"
					list="odin-rule-skills"
					value={action}
					placeholder="run /pr-iterate on it"
					onChange={(event) => setAction(event.target.value)}
					onKeyDown={onEnter}
					className={RULE_INPUT}
				/>
				<RepoModeToggle exclude={exclude} onChange={setExclude} />
				<RepoSelect value={repo} onChange={setRepo} />
				<button type="button" onClick={submit} className={ROW_PRIMARY_BUTTON}>
					Add rule
				</button>
			</div>
			<div className={FEED_LIST}>
				{rules.length === 0 && (
					<div className="px-2 py-8 text-center text-xs text-[#8a8a97]">
						No rules. Say what should happen when — every session Odin starts
						gets told.
					</div>
				)}
				{rules.map((rule) => (
					<RuleRow key={rule.id} rule={rule} />
				))}
			</div>
		</>
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
	const [view, setView] = useState<"schedules" | "rules">("schedules");
	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-2.5 border-b border-[#25252e] px-[18px] py-2.5">
				<span className="text-[13px] font-semibold text-[#f5f5f7]">
					Automations
				</span>
				{/* A segmented control, not two bare labels: the unselected one has
				    to look clickable too, or it reads as a caption. */}
				<div
					role="tablist"
					className="flex items-center gap-[2px] rounded-[8px] border border-[#25252e] bg-[#0a0a0c] p-[2px]"
				>
					{(
						[
							["schedules", "Schedules"],
							["rules", "Rules"],
						] as const
					).map(([value, label]) => (
						<button
							key={value}
							type="button"
							role="tab"
							aria-selected={view === value}
							onClick={() => setView(value)}
							className={cn(
								"cursor-pointer rounded-[6px] px-2.5 py-[3px] text-[12px] font-semibold transition-colors",
								view === value
									? "bg-[#2e2413] text-[#f5b83d]"
									: "bg-[#1f1f27] text-[#a5a5b3] hover:bg-[#2a2a34] hover:text-[#f5f5f7]",
							)}
						>
							{label}
						</button>
					))}
				</div>
				<span className="text-[12px] text-[#8a8a97]">
					{view === "schedules"
						? "tasks that start themselves, on a cron — while Odin is open"
						: "what every session Odin starts should do when something comes up"}
				</span>
			</div>
			{view === "schedules" ? <SchedulesPanel /> : <RulesPanel />}
		</div>
	);
}

function SchedulesPanel() {
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
		<>
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
										{task.builtin && <BuiltinChip />}
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
		</>
	);
}
