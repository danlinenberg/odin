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
}

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
export function parseTask(text: string): {
	title: string;
	notes: string;
	priority: number;
} {
	const [first = "", ...rest] = text.trim().split("\n");
	const [, bangs = "", title = ""] =
		/^(!*)\s*([\s\S]*)$/.exec(first.trim()) ?? [];
	return {
		title: title.trim(),
		notes: rest.join("\n").trim(),
		priority: bangs ? Math.min(bangs.length, 3) : DEFAULT_PRIORITY,
	};
}

export const useOdinTasks = create<{
	tasks: OdinTask[];
	/** Newest first. Blank text is a no-op — Enter on an empty box. */
	add: (text: string, profileId?: string) => void;
	edit: (id: string, text: string) => void;
	remove: (id: string) => void;
	/** Remember which session this task launched, so the row can jump to it. */
	setPane: (id: string, paneId: string) => void;
}>()(
	persist(
		(set) => ({
			tasks: [],
			add: (text, profileId) =>
				set((s) => {
					const { title, notes, priority } = parseTask(text);
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
							},
							...s.tasks,
						],
					};
				}),
			edit: (id, text) =>
				set((s) => {
					const { title, notes, priority } = parseTask(text);
					// Editing a task to nothing means deleting it — one fewer button.
					if (!title) return { tasks: s.tasks.filter((t) => t.id !== id) };
					return {
						tasks: s.tasks.map((t) =>
							t.id === id ? { ...t, title, notes, priority } : t,
						),
					};
				}),
			remove: (id) =>
				set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
			setPane: (id, paneId) =>
				set((s) => ({
					tasks: s.tasks.map((t) => (t.id === id ? { ...t, paneId } : t)),
				})),
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
		add: (text: string) => store.add(text, activeId),
	};
}

/**
 * The same text at another priority — what the select writes back into the
 * box. Rewrites the leading "!"s of the first line and touches nothing else.
 */
export function withPriority(text: string, priority: number): string {
	const [first = "", ...rest] = text.split("\n");
	const bare = first.trim().replace(/^!+\s*/, "");
	const level = Math.min(Math.max(priority, 1), 3);
	// Medium is what no "!"s already means, so the default writes none — the
	// box stays the text you typed until you actually pick Low or High.
	const bangs = level === DEFAULT_PRIORITY ? "" : "!".repeat(level);
	return [bangs ? `${bangs} ${bare}` : bare, ...rest].join("\n");
}

/** What you'd have to type to get this task back — the edit box's text. */
export function taskText(task: OdinTask): string {
	return withPriority(taskPrompt(task), priorityOf(task));
}

/** The prompt a task launches with — what you typed, minus the "!"s. */
export function taskPrompt(task: OdinTask): string {
	return task.notes ? `${task.title}\n\n${task.notes}` : task.title;
}
