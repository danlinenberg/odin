import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ODIN_HOME_DIR } from "main/lib/app-environment";

/**
 * The board's own state - tasks, automations, Night Agent settings, rules,
 * launch limits, reminders - as the window persists it (each zustand store's
 * JSON), mirrored here so the server's schedulers can act on it with the
 * laptop shut. One file per store key under <odin folder>/state.
 *
 * Writers: a store the user edits is written by the laptop only; scheduler
 * bookkeeping (when an automation last ran, tonight's Night Agent count) is
 * written by the server only, under its own `server:` keys. No key has two
 * writers, so neither side overwrites the other.
 */

export interface StateEntry {
	/** The store's persisted JSON, exactly as the window keeps it. */
	value: string;
	/** ms epoch of the write on the side that made it. */
	updatedAt: number;
}

const KEY = /^[a-z0-9:_-]{1,80}$/i;

function stateDir(): string {
	return join(ODIN_HOME_DIR, "state");
}

function fileFor(key: string): string {
	if (!KEY.test(key)) throw new Error(`Invalid state key: ${key}`);
	return join(stateDir(), `${key.replaceAll(":", "__")}.json`);
}

export function readStateEntry(key: string): StateEntry | null {
	try {
		const parsed = JSON.parse(readFileSync(fileFor(key), "utf8"));
		return typeof parsed?.value === "string" &&
			typeof parsed?.updatedAt === "number"
			? parsed
			: null;
	} catch {
		return null;
	}
}

export function writeStateEntry(key: string, entry: StateEntry): void {
	mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
	const file = fileFor(key);
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
	renameSync(temp, file);
}

/** A plain JSON key (shared/server-board.ts), or `fallback` when unset or unreadable. */
export function readJsonState<T>(key: string, fallback: T): T {
	const entry = readStateEntry(key);
	if (!entry) return fallback;
	try {
		return JSON.parse(entry.value) as T;
	} catch {
		return fallback;
	}
}

/** Write a server-owned key. Only the server's schedulers call this. */
export function writeJsonState(key: string, value: unknown): void {
	writeStateEntry(key, { value: JSON.stringify(value), updatedAt: Date.now() });
}

/** A mirrored store's current data, parsed (zustand persist's `{state}` envelope). */
export function readStoreState<T>(key: string): T | null {
	const entry = readStateEntry(key);
	if (!entry) return null;
	try {
		const parsed = JSON.parse(entry.value) as { state?: T };
		return parsed.state ?? null;
	} catch {
		return null;
	}
}
