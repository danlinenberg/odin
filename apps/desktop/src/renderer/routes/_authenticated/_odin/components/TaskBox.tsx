import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import type { AgentSkill } from "lib/trpc/routers/skills";
import type { OdinDoc } from "lib/trpc/routers/system";
import { useEffect, useRef, useState } from "react";
import { HiOutlineClock, HiOutlineSparkles, HiXMark } from "react-icons/hi2";
import { isHotkey, useHotkeyDisplay } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useClaudeCommand } from "renderer/stores/claude-command";
import { describeCron, nextRun } from "shared/cron";
import {
	PRIORITY_LABELS,
	parseTask,
	priorityOf,
	useMyTasks,
	useOdinTasks,
	withPriority,
	withSkill,
} from "../hooks/useOdinTasks";
import { useStartTask } from "../hooks/useStartTask";
import { ROW_PRIMARY_BUTTON } from "./FeedChrome";
import { readFile } from "./OdinPromptDialog";
import { BUTTON, PILL } from "./pill";
import { matchRepos, repoLabel } from "./repo-picker";
import { matchSkills } from "./skill-picker";

/** Adds lines under the task, as their own paragraph when it has only a title. */
const appendLines = (text: string, lines: string[]) =>
	[text.includes("\n") ? text : `${text}\n`, ...lines].join("\n");

/** Skill, Doc, Repo and Priority: one height and one outline, so the row
    reads as a set of fields rather than four differently-sized blobs. */
const FIELD =
	"h-6 rounded-[6px] bg-secondary px-2 text-[11px] font-semibold outline-none ring-1 ring-inset ring-border transition-[color,box-shadow] focus:ring-primary/60";

/** What the box takes on a drop or paste: photos, videos and markdown docs. */
const isAttachable = (file: File) =>
	/^(image|video)\//.test(file.type) || /\.md$/i.test(file.name);

/**
 * Dropped or pasted photos and videos, as paths the session can open. A task
 * is one string in localStorage, so it holds paths, never bytes: a file from
 * Finder is cited where it lies, a pasted screenshot is saved to disk first.
 * Imported on use so the box still renders without Electron (the tests).
 */
export async function attachmentPaths(files: File[]): Promise<string[]> {
	const [{ electronTrpcClient }, { parseDataUrl }] = await Promise.all([
		import("renderer/lib/trpc-client"),
		import("renderer/hooks/useLaunchTaskSession"),
	]);
	return Promise.all(
		files.map(async (file) => {
			const path = window.webUtils.getPathForFile(file);
			if (path) return path;
			const { dataUrl = "" } = await readFile(file);
			return electronTrpcClient.system.saveAttachment.mutate(
				parseDataUrl(dataUrl),
			);
		}),
	);
}

/**
 * The box you write a task in - compose row, edit row and the hotkey's quick
 * capture all use this one, so priority works the same in all three.
 *
 * One textbox: the first line names the card, the rest is the brief.
 *
 * Ctrl/⌘+Enter adds/saves, plain Enter is a newline, Escape
 * cancels. Plain Enter never submits - it fired half-written tasks.
 */
export function TaskBox({
	value,
	placeholder,
	autoFocus,
	hidePriority,
	compact,
	skills,
	docs,
	repos,
	repo,
	onRepoChange,
	recentRepos,
	onChange,
	onSubmit,
	onCancel,
	submitLabel,
}: {
	value: string;
	placeholder?: string;
	autoFocus?: boolean;
	/** Automations are scheduled, not ranked - the picker means nothing there. */
	hidePriority?: boolean;
	/**
	 * Folded to its title line until it's focused or holds text. For a box
	 * that sits above a list you came to read; ⌘N opens the full one anyway.
	 */
	compact?: boolean;
	/**
	 * The skills this box can offer. Passed in rather than fetched so the box
	 * stays a plain component - nothing here needs a tRPC context. Without it
	 * there's no Skill menu, and a skill typed into the title still works.
	 */
	skills?: AgentSkill[];
	/** Saved knowledge docs (system.listDocs). Passed in like `skills`. */
	docs?: OdinDoc[];
	/**
	 * The checkouts a session could run in. Passed with `onRepoChange`, the box
	 * shows a Repo field; `repo` is the current pick ("" / absent = none). Held
	 * apart from the text, unlike skill and priority - a path has no typed form
	 * worth teaching.
	 */
	repos?: string[];
	repo?: string;
	onRepoChange?: (repo: string) => void;
	/** One-click picks under the fields, newest first - like New Session's Recent row. */
	recentRepos?: string[];
	onChange: (text: string) => void;
	onSubmit: () => void;
	onCancel?: () => void;
	/** Shows a button that does what Ctrl/⌘+Enter does. */
	submitLabel?: string;
}) {
	const title = parseTask(value).title;
	const [focused, setFocused] = useState(false);
	const folded = !!compact && !focused && !value.trim();
	// Send (⌘Enter unless rebound) submits from anywhere in the box - Skill,
	// Repo and Priority too, since they are where you finish a task.
	const keys = (event: React.KeyboardEvent) => {
		if (isHotkey("SUBMIT", event.nativeEvent)) {
			event.preventDefault();
			onSubmit();
		}
		if (event.key === "Escape") onCancel?.();
	};
	// Paths go on their own lines at the end of the brief, where the session's
	// prompt picks them up like any other text.
	const attach = (list: FileList, event: React.SyntheticEvent) => {
		const files = [...list].filter(isAttachable);
		if (files.length === 0) return;
		event.preventDefault();
		attachmentPaths(files)
			.then((paths) => onChange(appendLines(value, paths)))
			.catch(() => toast.error("Couldn't attach that file"));
	};

	return (
		// Focus is tracked here, not on the fieldset: Skill, Repo and Priority sit
		// below it, and moving into one of them must not fold the box away.
		// biome-ignore lint/a11y/noStaticElementInteractions: focus and keys bubble up from the fields, nothing here is clickable
		<div
			className="flex h-full min-h-0 flex-col gap-2"
			onFocus={() => setFocused(true)}
			onKeyDown={keys}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget))
					setFocused(false);
			}}
		>
			{/* grow, not flex-1: the basis stays the rows=2 height, so inline use is
			    unchanged and only a resized dialog hands it extra room. */}
			<fieldset
				aria-label="Task"
				onDragOver={(event) => {
					if (event.dataTransfer.types.includes("Files"))
						event.preventDefault();
				}}
				onDrop={(event) => attach(event.dataTransfer.files, event)}
				onPaste={(event) => attach(event.clipboardData.files, event)}
				className={cn(
					"flex min-h-0 min-w-0 grow flex-col overflow-hidden rounded-[10px] border bg-card transition-[border-color,box-shadow] focus-within:border-primary/70 focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_18%,transparent)]",
					folded ? "border-dashed border-border" : "border-border",
				)}
			>
				<textarea
					value={value}
					placeholder={placeholder ?? "What needs doing?"}
					// biome-ignore lint/a11y/noAutofocus: the edit box replaces the row you clicked
					autoFocus={autoFocus}
					rows={folded ? 1 : 3}
					aria-label="Task"
					onChange={(event) => onChange(event.target.value)}
					className="w-full min-h-0 grow resize-none bg-transparent px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
				/>
			</fieldset>
			{/* The picker doesn't hold a value of its own: it rewrites the "!"s in
			    the text, which is what the store reads either way. Typing "!" and
			    picking Low are the same edit, so neither can go stale. Medium is
			    the no-"!"s case, so the box you just typed into already reads as it. */}
			{/* One row at the quick-add's 600px: Skill and Repo on the left,
			    Priority pushed right. Nothing in it grows as you type. */}
			{!folded && (
				<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
					{skills && skills.length > 0 && (
						<SkillSelect skills={skills} value={value} onChange={onChange} />
					)}
					{docs && docs.length > 0 && (
						<select
							aria-label="Doc"
							title="Add a saved doc to the brief - the session reads it for context"
							value=""
							onChange={(event) =>
								onChange(
									appendLines(value, [`Context doc: ${event.target.value}`]),
								)
							}
							// Fixed width: it always shows "Doc", so sizing it to the longest
							// title only pushed Repo onto the next line.
							className={cn(
								FIELD,
								"w-[72px] cursor-pointer text-muted-foreground hover:text-foreground",
							)}
						>
							<option value="" disabled>
								Doc
							</option>
							{docs.map((doc) => (
								<option key={doc.path} value={doc.path}>
									{doc.title}
								</option>
							))}
						</select>
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
							<span className="text-[11px] text-muted-foreground">
								Priority
							</span>
							<select
								aria-label="Priority"
								title="Or lead the title with ! (Low) or !!! (High) - no ! is Medium"
								value={parseTask(value).priority}
								onChange={(event) =>
									onChange(withPriority(value, Number(event.target.value)))
								}
								className={cn(
									FIELD,
									"cursor-pointer text-muted-foreground hover:text-foreground",
								)}
							>
								{/* Levels only - slot 0 ("None") is legacy storage, not a choice. */}
								{PRIORITY_LABELS.slice(1).map((label, index) => (
									<option key={label} value={index + 1}>
										{label}
									</option>
								))}
							</select>
						</div>
					)}
					{submitLabel && (
						<button
							type="button"
							disabled={!title.trim()}
							onClick={onSubmit}
							className={cn(ROW_PRIMARY_BUTTON, hidePriority && "ml-auto")}
						>
							{submitLabel}
						</button>
					)}
				</div>
			)}
			{!folded && onRepoChange && recentRepos && recentRepos.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-[11px] text-muted-foreground">Recent</span>
					{recentRepos.map((path) => (
						<button
							key={path}
							type="button"
							title={path}
							aria-pressed={repo === path}
							onClick={() => onRepoChange(repo === path ? "" : path)}
							className={cn(
								"h-6 max-w-[160px] truncate rounded-[6px] px-2 text-[11px] font-semibold transition-colors",
								repo === path ? BUTTON.selected : BUTTON.secondary,
							)}
						>
							{repoLabel(path)}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/**
 * Which skill the session opens with - the agent's own list, read off disk in
 * the main process.
 *
 * It writes a leading `/name` into the text rather than holding a value of its
 * own, exactly like the priority picker writes "!"s: typing `/gdpr` and
 * picking it from here are the same edit, so the menu and the box can't
 * disagree, and the edit box round-trips through one string.
 */
/**
 * Which skill the session opens with - the agent's own list, read off disk in
 * the main process.
 *
 * Picking writes a leading `/name` into the text rather than holding a value
 * of its own, exactly like the priority picker writes "!"s: typing `/gdpr`
 * into the title and choosing it here are the same edit, so the two can't
 * disagree and the edit box round-trips through one string.
 *
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
	// it - and the blur handler would then commit the half-typed query. A ref,
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
			<span className="text-[11px] text-muted-foreground">Skill</span>
			<input
				ref={box}
				aria-label="Skill"
				placeholder="search…"
				spellCheck={false}
				autoComplete="off"
				title="Open the session by running this skill, with the title as its argument. Type to search - by name or by what it does."
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
					// Tab only completes a search you typed: tabbing past the box
					// must not fill in the top of the list.
					const searched = query !== null && query !== current;
					// ⌘Enter is Send, so it carries on up to the box.
					const pick =
						(event.key === "Enter" && !isHotkey("SUBMIT", event.nativeEvent)) ||
						(event.key === "Tab" && searched);
					if (pick) {
						event.preventDefault();
						// Enter here picks a skill; it must not also submit the task.
						event.stopPropagation();
						const match = matches[active];
						if (match) commit(match.name);
					}
				}}
				className={cn(
					FIELD,
					"w-[130px] placeholder:font-normal placeholder:text-muted-foreground",
					// Amber, not red: a name the list doesn't know is usually a skill
					// installed on another machine, not a typo.
					current && !known ? "text-attention" : "text-foreground",
				)}
			/>
			{current && !known && query === null && (
				<span className="text-[11px] text-muted-foreground">not installed</span>
			)}
			{at && matches.length > 0 && (
				<div
					style={{ left: at.left, top: at.top }}
					className="fixed z-50 w-[340px] overflow-hidden rounded-[7px] border border-border bg-card shadow-[0_12px_40px_rgba(0,0,0,0.6)]"
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
								index === active && "bg-secondary",
							)}
						>
							<span className="shrink-0 font-mono text-[11px] font-semibold text-foreground">
								/{skill.name}
							</span>
							<span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">
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
 * Which checkout the session starts in - the New Session dialog's search.
 *
 * Resolved on every keystroke: exactly one hit is the pick, anything else is
 * none. Leaving the field rewrites a pick as its short `parent/name`, so the
 * box shows which repo it landed on instead of the head of a long path. The
 * state is the text colour - green picked, red not - with the why in the
 * tooltip, so the row never grows a note and wraps.
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
	// can't trip this - every keystroke writes back what the text resolves to.
	if (resolve(query).repo !== value) setQuery(value ? repoLabel(value) : "");
	const unresolved = query.trim() !== "" && !value;
	return (
		<div className="flex items-center gap-1.5">
			<span className="text-[11px] text-muted-foreground">Repo</span>
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
								? `${hits} repos match - type more of the name`
								: "No repo matches - the session will start without one"
							: "The checkout the session starts in. Type to search."
				}
				onChange={(event) => {
					setQuery(event.target.value);
					onChange(resolve(event.target.value).repo);
				}}
				onBlur={() => value && setQuery(repoLabel(value))}
				// Same :autofill override as the New Session dialog - a picked option
				// otherwise paints white-on-black over any bg-*.
				className={cn(
					FIELD,
					"w-[140px] [color-scheme:inherit] placeholder:font-normal placeholder:text-muted-foreground autofill:shadow-[inset_0_0_0_1000px_var(--secondary)] autofill:[-webkit-text-fill-color:var(--foreground)]",
					value
						? "text-foreground"
						: unresolved
							? "text-danger"
							: "text-muted-foreground",
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
			className="rounded-[5px] bg-secondary px-[7px] py-[1px] font-semibold text-muted-foreground"
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
			className={cn(
				"rounded-[5px] px-[7px] py-[1px] font-mono font-medium",
				PILL.neutral,
			)}
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
 * free - amber already means scheduled, green means skill, red means urgent -
 * and the row keeps the amber edge, because a built-in is still an automation.
 */
export function BuiltinChip() {
	return (
		<span
			title="Odin ships with this one. Edit it, retime it, pause it or delete it like any other - deleting is final, it won't come back."
			className={cn(
				"inline-flex items-center gap-1 rounded-[5px] px-[7px] py-[1px] font-semibold",
				PILL.brand,
			)}
		>
			<HiOutlineSparkles className="size-3" />
			Built-in
		</span>
	);
}

/**
 * Quieter the lower it is - High has to be the one that catches the eye, and
 * Medium is on most rows now that it's the default, so it can't shout.
 */
const PRIORITY_CHIP = [
	"",
	"bg-card text-faint-foreground",
	"bg-secondary text-muted-foreground",
	PILL.danger,
];

/** A task's priority on its row. Every task has one - no "!"s means Medium. */
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
 * What marks an automation out from the tasks around it: violet (Odin runs
 * it, like Night Agent and auto-started sessions), a clock, and
 * the schedule itself rather than a priority - an automation isn't urgent or
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
					? `Paused - schedule "${cron}" is not running`
					: `Runs on "${cron}"`
			}
			className={cn(
				"inline-flex items-center gap-1 rounded-[5px] px-[7px] py-[1px] font-semibold",
				paused ? "bg-card text-faint-foreground" : PILL.brand,
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

/** Where the dragged-out size lives between opens. */
const SIZE_KEY = "odin.quick-add-size";

/** A stored "620px,300px" back into the two inline styles, or null for the
    class defaults - an unset, half-written or hand-edited entry is not a size. */
export function parseSize(stored: string | null): [string, string] | null {
	const [width = "", height = ""] = (stored ?? "").split(",");
	return width.endsWith("px") && height.endsWith("px") ? [width, height] : null;
}

/**
 * Quick capture - the hotkey's box, over whatever you were looking at. The
 * task lands on My Tasks and you go back to what you were doing; walking to
 * the list to write it down is how a task gets lost on the way.
 */
export function QuickAddTask({ onClose }: { onClose: () => void }) {
	const { add } = useMyTasks();
	const { startTask } = useStartTask();
	const startNow = useClaudeCommand((state) => state.startNow);
	const setStartNow = useClaudeCommand((state) => state.setStartNow);
	const { data: skills } = electronTrpc.skills.list.useQuery();
	const { data: docs } = electronTrpc.system.listDocs.useQuery();
	const { data: repos = [] } = electronTrpc.repos.list.useQuery();
	const recentRepos = useClaudeCommand((state) => state.recentRepos);
	const addRecentRepo = useClaudeCommand((state) => state.addRecentRepo);
	const [draft, setDraft] = useState("");
	const [repo, setRepo] = useState("");
	const dialog = useRef<HTMLDivElement>(null);
	const { keys: submitKeys } = useHotkeyDisplay("SUBMIT");

	// The size you last dragged it to. Chromium writes the drag straight into the
	// element's inline style, so the element is the only source worth reading:
	// restore it on open, write it back on close.
	useEffect(() => {
		const box = dialog.current;
		if (!box) return;
		const size = parseSize(localStorage.getItem(SIZE_KEY));
		if (size) [box.style.width, box.style.height] = size;
		return () =>
			localStorage.setItem(SIZE_KEY, `${box.style.width},${box.style.height}`);
	}, []);

	const save = () => {
		// Same rule the store uses - no title, no task, so don't claim one.
		if (!parseTask(draft).title) return onClose();
		add(draft, undefined, repo);
		if (repo) addRecentRepo(repo);
		onClose();
		if (!startNow) return void toast.success("Added to My Tasks");
		// The store puts a new task first, so that's the one just added.
		const task = useOdinTasks.getState().tasks[0];
		if (task) void startTask(task);
	};

	return (
		<>
			<button
				type="button"
				aria-label="Cancel"
				className="fixed inset-0 z-40 cursor-default bg-black/50 bg-none"
				onClick={onClose}
			/>
			{/* Centred by auto margins, not a translate: a transformed box is the
			    containing block of every `fixed` descendant, and the Skill menu
			    places itself in viewport coordinates - inside a translated dialog
			    it landed off to the side and under this overflow clip, so it
			    never showed. min-h: a size dragged small before the footer
			    existed, read back from localStorage, must not squeeze the box
			    under three lines. */}
			<div
				ref={dialog}
				role="dialog"
				aria-modal="true"
				aria-label="New task"
				className="fixed inset-x-0 top-[12vh] z-50 mx-auto flex h-[300px] max-h-[80vh] min-h-[260px] w-[600px] min-w-[320px] max-w-[92vw] resize flex-col overflow-hidden rounded-[14px] border border-border bg-popover shadow-[0_24px_80px_rgba(0,0,0,0.6),inset_0_1px_0_rgb(255_255_255/0.04)]"
			>
				<div className="flex shrink-0 items-center px-4 pt-3 pb-2.5">
					<span className="text-[13px] font-semibold text-foreground">
						New task
					</span>
					<button
						type="button"
						aria-label="Close"
						onClick={onClose}
						className="-mr-1 ml-auto rounded-[6px] p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<HiXMark className="size-4" />
					</button>
				</div>
				<div className="flex min-h-0 grow flex-col px-4">
					<TaskBox
						value={draft}
						autoFocus
						skills={skills}
						docs={docs}
						repos={repos}
						repo={repo}
						onRepoChange={setRepo}
						recentRepos={recentRepos.filter((path) => repos.includes(path))}
						placeholder="What needs doing?"
						onChange={setDraft}
						onSubmit={save}
						onCancel={onClose}
					/>
				</div>
				{/* The footer is what a resize can't squeeze: TaskBox's brief takes
				    the slack, so the button never slides out of view. */}
				<div className="mt-3 flex shrink-0 items-center gap-3 border-t border-border bg-card/50 px-4 py-2.5">
					<label
						title="Start a session on it right away, not just add it to My Tasks"
						className="flex cursor-pointer select-none items-center gap-2 text-[11px] font-semibold text-soft-foreground"
					>
						<input
							type="checkbox"
							checked={startNow}
							onChange={(event) => setStartNow(event.target.checked)}
							className="peer sr-only"
						/>
						{/* A switch, not a checkbox: it's a mode the dialog remembers,
						    and the button below says what it does. */}
						<span
							aria-hidden
							className="relative h-4 w-7 rounded-full bg-secondary ring-1 ring-inset ring-border transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-3 after:rounded-full after:bg-soft-foreground after:transition-transform peer-checked:bg-primary peer-checked:ring-primary peer-checked:after:translate-x-3 peer-checked:after:bg-white peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary"
						/>
						Start now
					</label>
					<span className="ml-auto text-[11px] text-faint-foreground">
						esc to cancel
					</span>
					<button
						type="button"
						onClick={save}
						disabled={!parseTask(draft).title}
						// The name without the shortcut glyphs beside it.
						aria-label={startNow ? "Start session" : "Add task"}
						className={cn(
							"flex h-7 items-center gap-2 rounded-[7px] px-3 text-xs font-semibold disabled:cursor-default disabled:opacity-40 disabled:shadow-none",
							BUTTON.primary,
						)}
					>
						{startNow ? "Start session" : "Add task"}
						{submitKeys[0] !== "Unassigned" && (
							<span className="font-medium opacity-70">
								{submitKeys.join("")}
							</span>
						)}
					</button>
				</div>
			</div>
		</>
	);
}
