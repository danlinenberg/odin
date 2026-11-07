import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Where a task stands in Odin, beside the two it always had: no status is
 * "Waiting on you", and Done is the Done store. Odin-only - nothing is
 * written upstream, so a Jira row can be In review here and To Do in Jira.
 */
export const TASK_STATUSES = [
	{ id: "backlog", label: "Backlog" },
	{ id: "prioritised", label: "Prioritised" },
	{ id: "in-progress", label: "In progress" },
	{ id: "in-review", label: "In review" },
	{ id: "on-hold", label: "On hold" },
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number]["id"];

/** What kind of work a task is - set by hand, except a PR reads as a review. */
export const TASK_TYPES = [
	{ id: "meeting", label: "Prepare for meeting" },
	{ id: "code", label: "Write code" },
	{ id: "review", label: "Review code" },
	{ id: "read", label: "Read" },
] as const;
export type TaskType = (typeof TASK_TYPES)[number]["id"];

export const statusLabel = (id: string | undefined) =>
	TASK_STATUSES.find((s) => s.id === id)?.label ?? null;
export const typeLabel = (id: string | undefined) =>
	TASK_TYPES.find((t) => t.id === id)?.label ?? null;

/** The type in force: what you picked, else what the source implies (a PR is a review, a meeting is one to prepare for). */
export function typeOf(
	item: { key: string; source: string },
	types: Record<string, TaskType>,
): TaskType | undefined {
	return (
		types[item.key] ??
		(item.source === "GitHub"
			? "review"
			: item.source === "Calendar"
				? "meeting"
				: undefined)
	);
}

const KEEP = 500;

/** The map with `key` set (or cleared) last, trimmed to the newest KEEP. */
function put<T>(map: Record<string, T>, key: string, value: T | null) {
	const { [key]: _, ...rest } = map;
	const entries = Object.entries(rest);
	if (value) entries.push([key, value]);
	return Object.fromEntries(entries.slice(-KEEP));
}

/** Move one entry of a list from `from` to `to` - the queue's drag. */
export function moveKey(list: string[], from: string, to: string): string[] {
	const i = list.indexOf(from);
	const j = list.indexOf(to);
	if (i < 0 || j < 0 || i === j) return list;
	const next = [...list];
	next.splice(j, 0, ...next.splice(i, 1));
	return next;
}

/** Where a row goes on Up next: the top, the end, or a place counted from 1. */
export type QueuePlace = "top" | "end" | number;

/**
 * An API caller's Up next pick ("top", "end" or a place from 1). undefined
 * when none was given, null when it isn't one of those.
 */
export function parseQueuePlace(raw?: string): QueuePlace | null | undefined {
	const value = raw?.trim().toLowerCase();
	if (!value) return undefined;
	if (value === "top" || value === "end") return value;
	const n = Number(value);
	return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * The queue with `key` at `place`, moved there if it was already lined up. A
 * place past the end is the end. Over KEEP, the far end from the new row
 * falls off.
 */
export function placeKey(
	list: string[],
	key: string,
	place: QueuePlace,
): string[] {
	const rest = list.filter((k) => k !== key);
	const at =
		place === "top"
			? 0
			: place === "end"
				? rest.length
				: Math.min(place - 1, rest.length);
	const next = [...rest.slice(0, at), key, ...rest.slice(at)];
	if (next.length <= KEEP) return next;
	return at >= KEEP ? next.slice(-KEEP) : next.slice(0, KEEP);
}

/**
 * Per-row status, type and notes, and Up next - the rows you've lined up, in
 * the order you'll take them. Keyed by the All-feed key, like Done.
 * Bounded by KEEP: setting a row moves it to the end, and the oldest fall
 * off. Notes are for rows from Slack, Jira and the rest; your own tasks keep
 * theirs on the task.
 */
export const useTaskMeta = create<{
	statuses: Record<string, TaskStatus>;
	types: Record<string, TaskType>;
	notes: Record<string, string>;
	queue: string[];
	setStatus: (key: string, status: TaskStatus | null) => void;
	setType: (key: string, type: TaskType | null) => void;
	/** Your notes on a row, kept in Odin only; empty clears them. */
	setNote: (key: string, note: string) => void;
	enqueue: (key: string) => void;
	/** Line `key` up at `place`, for the API's add (action=add up_next=...). */
	enqueueAt: (key: string, place: QueuePlace) => void;
	dequeue: (key: string) => void;
	move: (from: string, to: string) => void;
}>()(
	persist(
		(set) => ({
			statuses: {},
			types: {},
			notes: {},
			queue: [],
			setStatus: (key, status) =>
				set((s) => ({ statuses: put(s.statuses, key, status) })),
			setType: (key, type) => set((s) => ({ types: put(s.types, key, type) })),
			setNote: (key, note) =>
				set((s) => ({ notes: put(s.notes, key, note.trim() || null) })),
			enqueue: (key) =>
				set((s) =>
					s.queue.includes(key) ? s : { queue: [...s.queue, key].slice(-KEEP) },
				),
			enqueueAt: (key, place) =>
				set((s) => ({ queue: placeKey(s.queue, key, place) })),
			dequeue: (key) =>
				set((s) => ({ queue: s.queue.filter((k) => k !== key) })),
			move: (from, to) => set((s) => ({ queue: moveKey(s.queue, from, to) })),
		}),
		{ name: "odin-task-meta" },
	),
);
