import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OdinTask } from "renderer/routes/_authenticated/_odin/hooks/odin-task";
import { hostPaths } from "./sessions";

/**
 * What the phone did on the remote host with the Mac away (Tasks with the
 * Mac closed), for the Mac to take in when it wakes (useAwayTasksSync): tasks
 * typed on the phone, and sessions marked Done there. One JSON line each,
 * appended, in files only this user reads (0600). The Mac clears what it took.
 */

/** A task typed on the phone. Its key is a Tasks key, so the board adopts it as one. */
export interface AddedTask {
	key: string;
	title: string;
	text: string;
	/** Epoch ms. */
	at: number;
}

/** A session the phone marked Done here: its task (when the runner started it) and its conversation. */
export interface DoneMark {
	key: string | null;
	sessionId: string;
	title: string;
	/** Epoch ms. */
	at: number;
}

const path = (name: string) => join(hostPaths.odin, "night", name);

function read<T>(name: string): T[] {
	try {
		return readFileSync(path(name), "utf8")
			.split("\n")
			.flatMap((line) => {
				try {
					return line ? [JSON.parse(line) as T] : [];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

function append(name: string, row: object): void {
	mkdirSync(join(hostPaths.odin, "night"), { recursive: true, mode: 0o700 });
	appendFileSync(path(name), `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

export const addedTasks = () => read<AddedTask>("added.jsonl");
export const doneMarks = () => read<DoneMark>("done.jsonl");

/** Keeps a task typed on the phone; its first line names it. */
export function addTask(text: string, now = Date.now()): AddedTask {
	const clean = text.trim();
	const task = {
		key: `task:${crypto.randomUUID()}`,
		title: clean.split("\n")[0].trim().slice(0, 200),
		text: clean,
		at: now,
	};
	append("added.jsonl", task);
	return task;
}

export function markDone(mark: DoneMark): void {
	append("done.jsonl", mark);
}

/** A typed task as one of my Tasks, for the host's board (allItems). */
export const asOdinTask = (task: AddedTask): OdinTask => ({
	id: task.key.slice("task:".length),
	title: task.title,
	notes: task.text.split("\n").slice(1).join("\n").trim(),
	createdAt: task.at,
});
