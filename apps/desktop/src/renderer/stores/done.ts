import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Long past the point a feed still lists a task you finished. */
const KEEP_MS = 90 * 86_400_000;

/** A row as it looked when it was done — it may have left its feed since. */
export interface DoneRow {
	at: number;
	title: string;
	source: string;
	url: string | null;
}

const HIDDEN_V0 = "odin-hidden-items";

/**
 * v0 → v1: timestamps become rows, and the old hidden keys become done. Also
 * the initial state, since persist only migrates a value that exists — and
 * someone who hid rows but never pressed Done has none.
 */
export function migrateDone(persisted: unknown): {
	done: Record<string, DoneRow>;
} {
	const old =
		(persisted as { done?: Record<string, number> } | null)?.done ?? {};
	const done: Record<string, DoneRow> = {};
	const add = (key: string, at: number) => {
		const colon = key.indexOf(":");
		done[key] = {
			at,
			title: key.slice(colon + 1),
			source: key.slice(0, colon),
			url: null,
		};
	};
	for (const [key, at] of Object.entries(old)) add(key, at);
	try {
		const hidden = JSON.parse(localStorage.getItem(HIDDEN_V0) ?? "{}")?.state
			?.hidden as Record<string, true> | undefined;
		for (const key of Object.keys(hidden ?? {}))
			if (!done[key]) add(key, Date.now());
	} catch {}
	return { done };
}

/**
 * Is this row done? By key, or by link for PRs, which the feeds key by id and
 * the sweep by repo#n. A mention newer than the Done brings the row back —
 * someone asked me something on it since — and Done again puts it away.
 */
export function doneChecker(done: Record<string, DoneRow>) {
	const byUrl = new Map(
		Object.values(done).flatMap((row) =>
			row.url ? [[row.url, row] as const] : [],
		),
	);
	return (item: {
		key: string;
		url?: string | null;
		mention?: { at?: string | null } | null;
	}) => {
		const row = done[item.key] ?? (item.url ? byUrl.get(item.url) : null);
		const askedAt = Date.parse(item.mention?.at ?? "");
		return !!row && !(askedAt > row.at);
	};
}

/**
 * Everything marked Done — from any feed, Next in line, or a Review drop.
 * Odin-only: nothing is written upstream (a Slack row also gets slack.setDone).
 * Keyed by the All-feed key, pruned after KEEP_MS so it stays a few KB. The
 * snapshot is what All tasks' Done list shows, since a done row may have left
 * its feed by then.
 */
export const useDoneStore = create<{
	done: Record<string, DoneRow>;
	setDone: (key: string, row: Omit<DoneRow, "at"> | null) => void;
}>()(
	persist(
		(set) => ({
			done: migrateDone(null).done,
			setDone: (key, row) => {
				set((state) => {
					const now = Date.now();
					const next = Object.fromEntries(
						Object.entries(state.done).filter(
							([k, d]) => k !== key && now - d.at < KEEP_MS,
						),
					);
					if (row) next[key] = { ...row, at: now };
					return { done: next };
				});
				// Written now, hidden keys and all, so the old list can go.
				try {
					localStorage.removeItem(HIDDEN_V0);
				} catch {}
			},
		}),
		{
			// The old Next-in-line list's name, so what was done stays done.
			name: "odin-next-in-line-done",
			version: 1,
			// v0 kept only a timestamp per key, and hiding was a second list of
			// keys. Hiding is gone: a hidden row is a done one now.
			migrate: migrateDone,
		},
	),
);
