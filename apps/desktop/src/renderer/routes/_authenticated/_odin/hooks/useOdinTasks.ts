import { useMemo } from "react";
import { profileOf } from "shared/odin-profile";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useOdinProfile } from "./useOdinProfile";

/**
 * One thing I decided to do myself — the feed with no upstream system behind
 * it. Jira, Slack and PRs are mirrors of other people's queues; this is the
 * list you type into when the thing you have to do isn't a ticket yet.
 */
export interface OdinTask {
	id: string;
	/** First line — names the card, the tab and the session. */
	title: string;
	/** The rest of what you typed: the actual ask, sent as the prompt. */
	notes: string;
	createdAt: number;
	/** 1–3 — Low, Medium, High (PRIORITY_LABELS). Absent (or 0) reads as Medium. */
	priority?: number;
	/** The session started from this task, once there is one. */
	paneId?: string;
	/**
	 * The profile that wrote it. Work todos and personal todos are different
	 * lists. Absent on tasks written before profiles — those read as default.
	 */
	profileId?: string;
	/**
	 * A five-field cron (or an `@daily` shorthand). Set = this is an
	 * automation: the runner starts it on the schedule instead of you, and it
	 * stays on the list afterwards. Absent = an ordinary one-shot task.
	 */
	cron?: string;
	/** Scheduled but held. The row stays; the clock stops. */
	paused?: boolean;
	/** The minute the schedule last fired, so one tick can't fire it twice. */
	lastRunAt?: number;
	/**
	 * The skill this runs — `gdpr`, `imagen-core:triage`. The session opens by
	 * invoking it, with the title as its argument, so a task that is really
	 * "run /ship-status" says so on the card instead of hiding it in prose.
	 */
	skill?: string;
	/**
	 * The built-in this row was installed from (`backlog-sweep`). Set = Odin
	 * wrote it, and the runner fills its prompt with context only the app can
	 * see. Everything else about it is an ordinary task: edit it, retime it,
	 * pause it, throw it away.
	 */
	builtin?: string;
}

/** Scheduled, so it runs itself — the one thing automations don't share. */
export const isAutomation = (task: OdinTask): boolean => !!task.cron;

/**
 * Priority by level — what the chip says and the select offers. Slot 0 is only
 * what tasks written before Medium was the default still hold; nothing writes
 * it any more and it reads as Medium.
 */
export const PRIORITY_LABELS = ["None", "Low", "Medium", "High"] as const;

/**
 * No "!"s means Medium. Everything you write down is something you mean to do —
 * "None" was a level that said nothing about when, and picking one on every
 * task is a tax. Say Low or High when it isn't the middle.
 */
export const DEFAULT_PRIORITY = 2;

/** A task's level, defaulting the ones stored before there was a default. */
export const priorityOf = (task: { priority?: number }): number =>
	task.priority || DEFAULT_PRIORITY;

/**
 * First line names it, the rest is the brief. Priority is typed: lead the
 * first line with "!" (Low) or "!!!" (High) and it sorts accordingly; no "!"
 * is Medium. The select next to the box writes the same "!"s, so there is one
 * source of truth and picking and typing can't disagree.
 */
/**
 * The first line's grammar, in one place: optional "!"s, an optional `/skill`,
 * then the name. The parser and both writers (priority, skill) go through
 * here, so picking from a menu and typing it by hand can't disagree.
 *
 * The skill token must be followed by a space or the end of the line —
 * otherwise a title that starts with a path ("/Users/dan/notes.md") would read
 * as a skill called `Users`.
 */
function splitFirstLine(first: string): {
	bangs: string;
	skill: string;
	title: string;
} {
	const [, bangs = "", rest = ""] =
		/^(!*)\s*([\s\S]*)$/.exec(first.trim()) ?? [];
	const slash = /^\/([\w:-]+)(?=\s|$)\s*([\s\S]*)$/.exec(rest);
	return {
		bangs,
		skill: slash?.[1] ?? "",
		title: (slash?.[2] ?? rest).trim(),
	};
}

const joinFirstLine = (parts: {
	bangs: string;
	skill: string;
	title: string;
}): string =>
	[parts.bangs, parts.skill && `/${parts.skill}`, parts.title]
		.filter(Boolean)
		.join(" ");

export function parseTask(text: string): {
	title: string;
	notes: string;
	priority: number;
	skill: string;
} {
	const [first = "", ...rest] = text.trim().split("\n");
	const { bangs, skill, title } = splitFirstLine(first);
	return {
		// "/ship-status" on its own is a task — the skill names it, so the card
		// isn't blank and `add` doesn't reject it as titleless.
		title: title || skill,
		notes: rest.join("\n").trim(),
		priority: bangs ? Math.min(bangs.length, 3) : DEFAULT_PRIORITY,
		skill,
	};
}

export const useOdinTasks = create<{
	tasks: OdinTask[];
	/**
	 * One entry per built-in already installed, keyed by profile. Kept apart
	 * from the tasks so deleting one is final — without it the row would be
	 * back on the next launch, which is the behaviour that teaches you to pause
	 * things you actually meant to throw away.
	 */
	seeded: string[];
	/**
	 * Newest first. Blank text is a no-op — Enter on an empty box. Pass a cron
	 * and it lands as an automation instead of a one-shot task.
	 */
	add: (text: string, profileId?: string, cron?: string) => void;
	/** Run this task through a skill, or through none (empty). */
	setSkill: (id: string, skill: string) => void;
	edit: (id: string, text: string) => void;
	remove: (id: string) => void;
	/** Remember which session this task launched, so the row can jump to it. */
	setPane: (id: string, paneId: string) => void;
	/** Put a task on a schedule, or take it off one (null). */
	setCron: (id: string, cron: string | null) => void;
	setPaused: (id: string, paused: boolean) => void;
	/** Stamp the minute an automation fired. */
	markRun: (id: string, at: number) => void;
	/**
	 * Install the built-ins this profile hasn't seen yet. The list is passed in
	 * rather than imported, so the store stays the plain thing the built-ins are
	 * defined against and not the other way round.
	 */
	installBuiltins: (
		profileId: string,
		builtins: { id: string; title: string; notes: string; cron: string }[],
	) => void;
}>()(
	persist(
		(set) => ({
			tasks: [],
			seeded: [],
			add: (text, profileId, cron) =>
				set((s) => {
					const { title, notes, priority, skill } = parseTask(text);
					if (!title) return s;
					return {
						tasks: [
							{
								id: crypto.randomUUID(),
								title,
								notes,
								priority,
								createdAt: Date.now(),
								profileId: profileOf(profileId),
								...(cron ? { cron } : {}),
								...(skill ? { skill } : {}),
							},
							...s.tasks,
						],
					};
				}),
			edit: (id, text) =>
				set((s) => {
					const { title, notes, priority, skill } = parseTask(text);
					// Editing a task to nothing means deleting it — one fewer button.
					if (!title) return { tasks: s.tasks.filter((t) => t.id !== id) };
					return {
						tasks: s.tasks.map((t) =>
							// skill is written on every edit, so clearing it in the box
							// clears it on the task rather than leaving the old one.
							t.id === id
								? { ...t, title, notes, priority, skill: skill || undefined }
								: t,
						),
					};
				}),
			remove: (id) =>
				set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
			setPane: (id, paneId) =>
				set((s) => ({
					tasks: s.tasks.map((t) => (t.id === id ? { ...t, paneId } : t)),
				})),
			setCron: (id, cron) =>
				set((s) => ({
					tasks: s.tasks.map((t) =>
						t.id === id ? { ...t, cron: cron ?? undefined } : t,
					),
				})),
			setSkill: (id, skill) =>
				set((s) => ({
					tasks: s.tasks.map((t) =>
						t.id === id ? { ...t, skill: skill || undefined } : t,
					),
				})),
			setPaused: (id, paused) =>
				set((s) => ({
					tasks: s.tasks.map((t) => (t.id === id ? { ...t, paused } : t)),
				})),
			markRun: (id, at) =>
				set((s) => ({
					tasks: s.tasks.map((t) =>
						t.id === id ? { ...t, lastRunAt: at } : t,
					),
				})),
			installBuiltins: (profileId, builtins) =>
				set((s) => {
					// `?? []` for installs that predate this field: persisted state
					// is merged over the defaults, not migrated.
					const seeded = s.seeded ?? [];
					const key = (id: string) => `${profileId}:${id}`;
					const fresh = builtins.filter(
						(builtin) => !seeded.includes(key(builtin.id)),
					);
					if (fresh.length === 0) return s;
					return {
						seeded: [...seeded, ...fresh.map((builtin) => key(builtin.id))],
						tasks: [
							...fresh.map((builtin) => ({
								id: crypto.randomUUID(),
								title: builtin.title,
								notes: builtin.notes,
								priority: DEFAULT_PRIORITY,
								createdAt: Date.now(),
								profileId,
								cron: builtin.cron,
								builtin: builtin.id,
							})),
							...s.tasks,
						],
					};
				}),
		}),
		{ name: "odin-tasks" },
	),
);

/**
 * The task list as a view of the active profile — what every screen wants.
 * The store keeps every profile's tasks in one array (it's one localStorage
 * key either way); this is the only way anything reads it.
 */
export function useMyTasks() {
	const { activeId, isLoading } = useOdinProfile();
	const store = useOdinTasks();
	const tasks = useMemo(
		// Until the profile is known, show nothing rather than the default
		// profile's list — on a reload inside another profile that would flash
		// someone else's todos before settling.
		() =>
			isLoading
				? []
				: store.tasks
						.filter((task) => profileOf(task.profileId) === activeId)
						// Urgent first, newest first within a level (the store's own order).
						.sort((a, b) => priorityOf(b) - priorityOf(a)),
		[store.tasks, activeId, isLoading],
	);
	return {
		...store,
		tasks,
		/**
		 * The list minus the automations. Everything that counts "what's waiting
		 * on you" — the tab badge, the All feed — asks for this one: a schedule
		 * that fires itself is not a thing sitting on you.
		 */
		todos: useMemo(() => tasks.filter((task) => !isAutomation(task)), [tasks]),
		automations: useMemo(() => tasks.filter(isAutomation), [tasks]),
		add: (text: string, cron?: string) => store.add(text, activeId, cron),
	};
}

/**
 * The same text at another priority — what the select writes back into the
 * box. Rewrites the leading "!"s of the first line and touches nothing else.
 */
export function withPriority(text: string, priority: number): string {
	const [first = "", ...rest] = text.split("\n");
	const level = Math.min(Math.max(priority, 1), 3);
	// Medium is what no "!"s already means, so the default writes none — the
	// box stays the text you typed until you actually pick Low or High.
	const bangs = level === DEFAULT_PRIORITY ? "" : "!".repeat(level);
	return [joinFirstLine({ ...splitFirstLine(first), bangs }), ...rest].join(
		"\n",
	);
}

/**
 * The same text running a different skill — what the Skill menu writes back
 * into the box. An empty name takes the skill off.
 */
export function withSkill(text: string, skill: string): string {
	const [first = "", ...rest] = text.split("\n");
	return [joinFirstLine({ ...splitFirstLine(first), skill }), ...rest].join(
		"\n",
	);
}

/** What you'd have to type to get this task back — the edit box's text. */
export function taskText(task: OdinTask): string {
	return withSkill(
		withPriority(taskPrompt(task), priorityOf(task)),
		task.skill ?? "",
	);
}

/** The prompt a task launches with — what you typed, minus the "!"s. */
export function taskPrompt(task: OdinTask): string {
	return task.notes ? `${task.title}\n\n${task.notes}` : task.title;
}
