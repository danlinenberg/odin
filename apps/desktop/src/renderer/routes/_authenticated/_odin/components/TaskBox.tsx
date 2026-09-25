import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import type { AgentSkill } from "lib/trpc/routers/skills";
import { useEffect, useRef, useState } from "react";
import { HiOutlineClock, HiOutlineSparkles } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { describeCron, nextRun } from "shared/cron";
import {
	PRIORITY_LABELS,
	parseTask,
	priorityOf,
	useMyTasks,
	withPriority,
	withSkill,
} from "../hooks/useOdinTasks";
import { matchRepos, repoLabel } from "./repo-picker";
import { matchSkills } from "./skill-picker";

/** Title is the first line, the brief is the rest — the two fields the box
    shows are the two halves of the one string the store reads. */
const splitTask = (text: string): [string, string] => {
	const [title = "", ...rest] = text.split("\n");
	return [title, rest.join("\n").replace(/^\n+/, "")];
};
const joinTask = (title: string, notes: string) =>
	notes ? `${title}\n\n${notes}` : title;

/**
 * The box you write a task in — compose row, edit row and the hotkey's quick
 * capture all use this one, so priority works the same in all three.
 *
 * Two fields rather than one: which half names the card and which half is the
 * brief was a sentence of placeholder text you had to read and believe. A
 * labelled line and a labelled box say it without the sentence.
 *
 * Enter adds/saves, Shift+Enter in the brief is a newline, Escape cancels.
 */
export function TaskBox({
	value,
	placeholder,
	autoFocus,
	hidePriority,
	skills,
	repos,
	repo,
	onRepoChange,
	onChange,
	onSubmit,
	onCancel,
}: {
	value: string;
	placeholder?: string;
	autoFocus?: boolean;
	/** Automations are scheduled, not ranked — the picker means nothing there. */
	hidePriority?: boolean;
	/**
	 * The skills this box can offer. Passed in rather than fetched so the box
	 * stays a plain component — nothing here needs a tRPC context. Without it
	 * there's no Skill menu, and a skill typed into the title still works.
	 */
	skills?: AgentSkill[];
	/**
	 * The checkouts a session could run in. Passed with `onRepoChange`, the box
	 * shows a Repo field; `repo` is the current pick ("" / absent = none). Held
	 * apart from the text, unlike skill and priority — a path has no typed form
	 * worth teaching.
	 */
	repos?: string[];
	repo?: string;
	onRepoChange?: (repo: string) => void;
	onChange: (text: string) => void;
	onSubmit: () => void;
	onCancel?: () => void;
}) {
	const [title, notes] = splitTask(value);
	// Enter submits from either field; only the brief keeps Shift+Enter.
	const keys = (event: React.KeyboardEvent) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			onSubmit();
		}
		if (event.key === "Escape") onCancel?.();
	};

	return (
		<div className="flex h-full min-h-0 flex-col gap-1.5">
			{/* grow, not flex-1: the basis stays the rows=2 height, so inline use is
			    unchanged and only a resized dialog hands it extra room. */}
			<div className="flex min-h-0 grow flex-col overflow-hidden rounded-[10px] border border-[#25252e] bg-[#111114] focus-within:border-[#a394ff]">
				<input
					value={title}
					placeholder={placeholder ?? "Name it"}
					// biome-ignore lint/a11y/noAutofocus: the edit box replaces the row you clicked
					autoFocus={autoFocus}
					aria-label="Title"
					onChange={(event) => onChange(joinTask(event.target.value, notes))}
					onKeyDown={keys}
					className="w-full bg-transparent px-3 pt-2 pb-1.5 text-[13px] font-semibold text-[#f5f5f7] outline-none placeholder:font-normal placeholder:text-[#8a8a97]"
				/>
				<div className="mx-3 border-t border-[#25252e]" />
				<textarea
					value={notes}
					placeholder="The brief — what it needs, links, anything the session should know (optional)"
					rows={2}
					aria-label="Brief"
					onChange={(event) => onChange(joinTask(title, event.target.value))}
					onKeyDown={keys}
					className="w-full min-h-0 grow resize-none bg-transparent px-3 pt-1.5 pb-2 text-[13px] text-[#a5a5b3] outline-none placeholder:text-[#8a8a97]"
				/>
			</div>
			{/* The picker doesn't hold a value of its own: it rewrites the "!"s in
			    the text, which is what the store reads either way. Typing "!" and
			    picking Low are the same edit, so neither can go stale. Medium is
			    the no-"!"s case, so the box you just typed into already reads as it.

			    ponytail: a native <select> — it opens as a real menu, it's keyboard
			    navigable for free, and there's no popup to style. */}
			{/* One row at the quick-add's 520px: Skill and Repo on the left,
			    Priority pushed right. Nothing in it grows as you type. */}
			<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
				{skills && skills.length > 0 && (
					<SkillSelect skills={skills} value={value} onChange={onChange} />
				)}
				{repos && repos.length > 0 && onRepoChange && (
					<RepoSelect
						repos={repos}
						value={repo ?? ""}
						onChange={onRepoChange}
					/>
				)}
				{!hidePriority && (
					<div className="ml-auto flex items-center gap-1.5">
						<span className="text-[11px] text-[#8a8a97]">Priority</span>
						<select
							aria-label="Priority"
							title="Or lead the title with ! (Low) or !!! (High) — no ! is Medium"
							value={parseTask(value).priority}
							onChange={(event) =>
								onChange(withPriority(value, Number(event.target.value)))
							}
							className="cursor-pointer rounded-[6px] bg-[#1f1f27] px-1.5 py-[3px] text-[11px] font-semibold text-[#a5a5b3] outline-none transition-colors hover:text-[#f5f5f7]"
						>
							{/* Levels only — slot 0 ("None") is legacy storage, not a choice. */}
							{PRIORITY_LABELS.slice(1).map((label, index) => (
								<option key={label} value={index + 1}>
									{label}
								</option>
							))}
						</select>
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * Which skill the session opens with — the agent's own list, read off disk in
 * the main process.
 *
 * It writes a leading `/name` into the text rather than holding a value of its
 * own, exactly like the priority picker writes "!"s: typing `/gdpr` and
 * picking it from here are the same edit, so the menu and the box can't
 * disagree, and the edit box round-trips through one string.
 *
 * ponytail: a native `<select>`. Long list, but it's the platform's own menu —
 * scrolling, type-to-search and keyboard nav for free. A search field if it
 * ever outgrows a menu.
 */
/**
 * Which skill the session opens with — the agent's own list, read off disk in
 * the main process.
 *
 * Picking writes a leading `/name` into the text rather than holding a value
 * of its own, exactly like the priority picker writes "!"s: typing `/gdpr`
 * into the title and choosing it here are the same edit, so the two can't
 * disagree and the edit box round-trips through one string.
 *
 * ponytail: the menu is drawn here rather than by a native `<datalist>`. Eighty
 * skills need search either way, and `matchSkills` — the composer's own
 * ranking, name matches before description matches — already exists and is
 * tested. A native popup also can't show a description, can't be styled to
 * match, and is the one widget that can't be verified from the outside.
 *
 * It's `fixed` and measured on open because the rows it appears in live in a
 * scroll container, which would clip an absolutely-positioned menu.
 */
function SkillSelect({
	skills,
	value,
	onChange,
}: {
	skills: AgentSkill[];
	value: string;
	onChange: (text: string) => void;
}) {
	const current = parseTask(value).skill;
	const known = skills.some((skill) => skill.name === current);
	// null = not searching, so the box shows the skill that's set.
	const [query, setQuery] = useState<string | null>(null);
	const [selected, setSelected] = useState(0);
	const [at, setAt] = useState<{ left: number; top: number } | null>(null);
	const box = useRef<HTMLInputElement>(null);
	// Escape has to abandon the search, but blurring the box is what dismisses
	// it — and the blur handler would then commit the half-typed query. A ref,
	// not state: it is read inside the blur that Escape itself triggers, before
	// React has re-rendered.
	const abandoned = useRef(false);

	const matches = query === null ? [] : matchSkills(skills, query, 7);
	const active = Math.min(selected, Math.max(matches.length - 1, 0));

	const open = () => {
		const rect = box.current?.getBoundingClientRect();
		if (rect) setAt({ left: rect.left, top: rect.bottom + 4 });
		setQuery(current);
		setSelected(0);
	};
	const close = () => {
		setQuery(null);
		setAt(null);
	};
	const commit = (name: string) => {
		// A pasted "/gdpr" is the obvious move, and a space would split the token
		// in two, so both are cleaned off before it's written.
		onChange(
			withSkill(value, name.trim().replace(/^\/+/, "").split(/\s/)[0] ?? ""),
		);
		close();
	};

	return (
		<div className="flex items-center gap-1.5">
			<span className="text-[11px] text-[#8a8a97]">Skill</span>
			<input
				ref={box}
				aria-label="Skill"
				placeholder="search…"
				spellCheck={false}
				autoComplete="off"
				title="Open the session by running this skill, with the title as its argument. Type to search — by name or by what it does."
				value={query ?? current}
				onFocus={open}
				onChange={(event) => {
					setQuery(event.target.value);
					setSelected(0);
				}}
				onBlur={() => {
					if (abandoned.current) {
						abandoned.current = false;
						return close();
					}
					commit(query ?? current);
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						// Only this box: Escape in the compose row would otherwise
						// throw away the task you were writing too.
						event.preventDefault();
						event.stopPropagation();
						abandoned.current = true;
						box.current?.blur();
						return;
					}
					if (matches.length === 0) return;
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						const step = event.key === "ArrowDown" ? 1 : matches.length - 1;
						setSelected((index) => (index + step) % matches.length);
						return;
					}
					if (event.key === "Enter" || event.key === "Tab") {
						event.preventDefault();
						// Enter here picks a skill; it must not also submit the task.
						event.stopPropagation();
						const match = matches[active];
						if (match) commit(match.name);
					}
				}}
				className={cn(
					"w-[130px] rounded-[6px] bg-[#1f1f27] px-1.5 py-[3px] text-[11px] font-semibold outline-none transition-colors placeholder:font-normal placeholder:text-[#8a8a97]",
					// Amber, not red: a name the list doesn't know is usually a skill
					// installed on another machine, not a typo.
					current && !known ? "text-[#f5b83d]" : "text-[#3ecf8e]",
				)}
			/>
			{current && !known && query === null && (
				<span className="text-[11px] text-[#8a8a97]">not installed</span>
			)}
			{at && matches.length > 0 && (
				<div
					style={{ left: at.left, top: at.top }}
					className="fixed z-50 w-[340px] overflow-hidden rounded-[7px] border border-[#2e2e38] bg-[#16161b] shadow-[0_12px_40px_rgba(0,0,0,0.6)]"
				>
					{matches.map((skill, index) => (
						<button
							key={skill.name}
							type="button"
							onMouseEnter={() => setSelected(index)}
							// The input keeps focus: mousedown fires before blur, so the
							// pick lands instead of the blur committing the query.
							onMouseDown={(event) => {
								event.preventDefault();
								commit(skill.name);
							}}
							className={cn(
								"flex w-full items-baseline gap-2 px-2.5 py-1 text-left",
								index === active && "bg-[#1f1f27]",
							)}
						>
							<span className="shrink-0 text-[11px] font-semibold text-[#3ecf8e]">
								/{skill.name}
							</span>
							<span className="min-w-0 flex-1 truncate text-[10.5px] text-[#a5a5b3]">
								{skill.description}
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/**
 * Which checkout the session starts in — the New Session dialog's search.
 *
 * Resolved on every keystroke: exactly one hit is the pick, anything else is
 * none. Leaving the field rewrites a pick as its short `parent/name`, so the
 * box shows which repo it landed on instead of the head of a long path. The
 * state is the text colour — green picked, red not — with the why in the
 * tooltip, so the row never grows a note and wraps.
 *
 * ponytail: native `<datalist>` — Chromium does search-as-you-type over the
 * paths for free.
 */
function RepoSelect({
	repos,
	value,
	onChange,
}: {
	repos: string[];
	value: string;
	onChange: (repo: string) => void;
}) {
	// A label first: "private/odin" must not go ambiguous over the worktrees
	// that live under that checkout.
	const resolve = (text: string): { repo: string; hits: number } => {
		const labelled = repos.find((path) => repoLabel(path) === text.trim());
		if (labelled) return { repo: labelled, hits: 1 };
		const hits = matchRepos(repos, text);
		return {
			repo: hits.length === 1 ? (hits[0] as string) : "",
			hits: hits.length,
		};
	};
	const [query, setQuery] = useState(value ? repoLabel(value) : "");
	const { hits } = resolve(query);
	// Set from outside (the compose row clearing after Enter): follow it. Typing
	// can't trip this — every keystroke writes back what the text resolves to.
	if (resolve(query).repo !== value) setQuery(value ? repoLabel(value) : "");
	const unresolved = query.trim() !== "" && !value;
	return (
		<div className="flex items-center gap-1.5">
			<span className="text-[11px] text-[#8a8a97]">Repo</span>
			<input
				list="odin-task-repos"
				aria-label="Repo"
				value={query}
				spellCheck={false}
				autoComplete="off"
				placeholder="agent picks"
				title={
					value
						? value
						: unresolved
							? hits > 1
								? `${hits} repos match — type more of the name`
								: "No repo matches — the session will start without one"
							: "The checkout the session starts in. Type to search."
				}
				onChange={(event) => {
					setQuery(event.target.value);
					onChange(resolve(event.target.value).repo);
				}}
				onBlur={() => value && setQuery(repoLabel(value))}
				// Same :autofill override as the New Session dialog — a picked option
				// otherwise paints white-on-black over any bg-*.
				className={cn(
					"w-[140px] rounded-[6px] bg-[#1f1f27] px-1.5 py-[3px] text-[11px] font-semibold outline-none [color-scheme:dark] placeholder:font-normal placeholder:text-[#8a8a97] autofill:shadow-[inset_0_0_0_1000px_#1f1f27] autofill:[-webkit-text-fill-color:#3ecf8e]",
					value
						? "text-[#3ecf8e]"
						: unresolved
							? "text-[#f0647a]"
							: "text-[#a5a5b3]",
				)}
			/>
			<datalist id="odin-task-repos">
				{repos.map((path) => (
					<option key={path} value={path}>
						{repoLabel(path)}
					</option>
				))}
			</datalist>
		</div>
	);
}

/** The checkout a task's session runs in, on its row. */
export function RepoChip({ repo }: { repo: string }) {
	return (
		<span
			title={`Runs in ${repo}`}
			className="rounded-[5px] bg-[#1f1f27] px-[7px] py-[1px] font-semibold text-[#a5a5b3]"
		>
			{repoLabel(repo)}
		</span>
	);
}

/** The skill a task runs, on its row. Green, matching the composer's menu. */
export function SkillChip({ skill }: { skill: string }) {
	return (
		<span
			title={`Runs /${skill}`}
			className="rounded-[5px] bg-[#0f2a1c] px-[7px] py-[1px] font-semibold text-[#3ecf8e]"
		>
			/{skill}
		</span>
	);
}

/**
 * One Odin wrote, not you.
 *
 * Its own colour rather than a quiet grey note: on a list you scan, the
 * question a built-in raises is "where did THAT come from?", and an answer
 * pitched at the same weight as "last ran never" doesn't get read. Violet is
 * free — amber already means scheduled, green means skill, red means urgent —
 * and the row keeps the amber edge, because a built-in is still an automation.
 */
export function BuiltinChip() {
	return (
		<span
			title="Odin ships with this one. Edit it, retime it, pause it or delete it like any other — deleting is final, it won't come back."
			className="inline-flex items-center gap-1 rounded-[5px] bg-[#221a38] px-[7px] py-[1px] font-semibold text-[#a78bfa]"
		>
			<HiOutlineSparkles className="size-3" />
			built-in
		</span>
	);
}

/**
 * Quieter the lower it is — High has to be the one that catches the eye, and
 * Medium is on most rows now that it's the default, so it can't shout.
 */
const PRIORITY_CHIP = [
	"",
	"bg-[#17171c] text-[#6f6f7d]",
	"bg-[#1f1f27] text-[#a5a5b3]",
	"bg-[#3a1a20] text-[#f0647a]",
];

/** A task's priority on its row. Every task has one — no "!"s means Medium. */
export function PriorityChip({ priority }: { priority?: number }) {
	const level = priorityOf({ priority });
	return (
		<span
			className={cn(
				"rounded-[5px] px-[7px] py-[1px] font-semibold",
				PRIORITY_CHIP[level],
			)}
		>
			{PRIORITY_LABELS[level]}
		</span>
	);
}

/**
 * How a next run is written, everywhere it's written. Weekday AND date: "next
 * Fri 04:00" reads as this week, and a schedule three months out would be
 * saying something false.
 */
export const NEXT_RUN_FORMAT: Intl.DateTimeFormatOptions = {
	weekday: "short",
	day: "numeric",
	month: "short",
	hour: "2-digit",
	minute: "2-digit",
};

/**
 * What marks an automation out from the tasks around it: amber, a clock, and
 * the schedule itself rather than a priority — an automation isn't urgent or
 * not, it's due or it isn't. Paused says so in place of the next run, because
 * "every day at 9" on a row that will never fire is a lie.
 */
export function AutomationChip({
	cron,
	paused,
}: {
	cron: string;
	paused?: boolean;
}) {
	const next = paused ? null : nextRun(cron);
	return (
		<span
			title={
				paused
					? `Paused — schedule "${cron}" is not running`
					: `Runs on "${cron}"`
			}
			className={cn(
				"inline-flex items-center gap-1 rounded-[5px] px-[7px] py-[1px] font-semibold",
				paused ? "bg-[#17171c] text-[#6f6f7d]" : "bg-[#2e2413] text-[#f5b83d]",
			)}
		>
			<HiOutlineClock className="size-3" />
			{/* In words, not in cron: this row is being scanned, not edited, and
			    "0 9 * * 1-5" is something you decode. The panel is where the
			    expression itself is worth seeing, and the tooltip has it here. */}
			<span>{describeCron(cron)}</span>
			<span className="font-normal opacity-70">
				{paused
					? "paused"
					: next
						? `· next ${next.toLocaleString(undefined, NEXT_RUN_FORMAT)}`
						: "· never fires"}
			</span>
		</span>
	);
}

/**
 * The same chip for a source with its own names for the levels — Jira's
 * Highest, Notion's Low. A level it shares with ours is coloured like ours;
 * anything else (P1, Blocker) stays grey rather than guessing at severity.
 */
export function PriorityLabelChip({ label }: { label: string }) {
	const level = PRIORITY_LABELS.findIndex(
		(known, i) => i > 0 && label.toLowerCase().startsWith(known.toLowerCase()),
	);
	return (
		<span
			className={cn(
				"truncate rounded-[5px] px-[7px] py-[1px] font-semibold",
				level > 0 ? PRIORITY_CHIP[level] : "bg-[#1f1f27] text-[#a5a5b3]",
			)}
		>
			{label}
		</span>
	);
}

/** Where the dragged-out size lives between opens. */
const SIZE_KEY = "odin.quick-add-size";

/** A stored "620px,300px" back into the two inline styles, or null for the
    class defaults — an unset, half-written or hand-edited entry is not a size. */
export function parseSize(stored: string | null): [string, string] | null {
	const [width = "", height = ""] = (stored ?? "").split(",");
	return width.endsWith("px") && height.endsWith("px") ? [width, height] : null;
}

/**
 * Quick capture — the hotkey's box, over whatever you were looking at. The
 * task lands on My Tasks and you go back to what you were doing; walking to
 * the list to write it down is how a task gets lost on the way.
 */
export function QuickAddTask({ onClose }: { onClose: () => void }) {
	const { add } = useMyTasks();
	const { data: skills } = electronTrpc.skills.list.useQuery();
	const { data: repos } = electronTrpc.repos.list.useQuery();
	const [draft, setDraft] = useState("");
	const [repo, setRepo] = useState("");
	const dialog = useRef<HTMLDivElement>(null);

	// The size you last dragged it to. Chromium writes the drag straight into the
	// element's inline style, so the element is the only source worth reading:
	// restore it on open, write it back on close. ponytail: localStorage — a
	// remembered box size isn't state worth a migration.
	useEffect(() => {
		const box = dialog.current;
		if (!box) return;
		const size = parseSize(localStorage.getItem(SIZE_KEY));
		if (size) [box.style.width, box.style.height] = size;
		return () =>
			localStorage.setItem(SIZE_KEY, `${box.style.width},${box.style.height}`);
	}, []);

	const save = () => {
		// Same rule the store uses — no title, no task, so don't claim one.
		if (!parseTask(draft).title) return onClose();
		add(draft, undefined, repo);
		toast.success("Added to My Tasks");
		onClose();
	};

	return (
		<>
			<button
				type="button"
				aria-label="Cancel"
				className="fixed inset-0 z-40 cursor-default bg-black/50 bg-none"
				onClick={onClose}
			/>
			<div
				ref={dialog}
				role="dialog"
				aria-modal="true"
				aria-label="New task"
				// ponytail: CSS `resize` — Chromium draws the corner grip for free.
				className="fixed left-1/2 top-[12vh] z-50 flex h-[190px] max-h-[80vh] w-[520px] min-w-[320px] max-w-[92vw] -translate-x-1/2 resize flex-col overflow-hidden rounded-[10px] border border-[#2e2e38] bg-[#111114] p-3.5 shadow-[0_18px_60px_rgba(0,0,0,0.6)]"
			>
				{/* The button sits in the header, not under the fields: the dialog's
				    height is fixed and the fields row is already full at 520px. */}
				<div className="mb-2 flex shrink-0 items-center text-xs font-semibold text-[#f5f5f7]">
					New task
					<span className="ml-1.5 font-normal text-[#8a8a97]">
						⏎ add · esc cancel
					</span>
					<button
						type="button"
						onClick={save}
						disabled={!parseTask(draft).title}
						className="ml-auto rounded-[6px] bg-[#a394ff] px-2.5 py-[3px] text-[11px] font-semibold text-[#111114] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
					>
						Add task
					</button>
				</div>
				<TaskBox
					value={draft}
					autoFocus
					skills={skills}
					repos={repos}
					repo={repo}
					onRepoChange={setRepo}
					placeholder="What needs doing?"
					onChange={setDraft}
					onSubmit={save}
					onCancel={onClose}
				/>
			</div>
		</>
	);
}
