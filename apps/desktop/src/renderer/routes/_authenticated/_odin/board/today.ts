/**
 * The Today overview: every open session on the board, grouped by where it
 * stands and ordered by what to look at first. Built only from what the board
 * and Tasks already know - the card's column, Ping me, a linked task's due
 * date, priority and Waiting on, and Catch up's call.
 */

export type TodayGroup =
	| "needs-you"
	| "almost-done"
	| "running"
	| "waiting"
	| "paused";

export const TODAY_GROUPS: {
	id: TodayGroup;
	label: string;
	hint: string;
}[] = [
	{
		id: "needs-you",
		label: "Needs you",
		hint: "a question, an approval or a decision",
	},
	{
		id: "almost-done",
		label: "Almost done",
		hint: "only a merge, a look or a test is left",
	},
	{ id: "running", label: "Running", hint: "Claude is working on it" },
	{
		id: "waiting",
		label: "Waiting on someone",
		hint: "a reply, a review or another person's work",
	},
	{ id: "paused", label: "On hold", hint: "put down for now" },
];

export const todayGroupLabel = (id: TodayGroup) =>
	TODAY_GROUPS.find((g) => g.id === id)?.label ?? id;

/** A board session as the overview reads it. */
export interface TodaySignals {
	/** The board column: working, permission (Needs you), review (Final review), idle. */
	column: "working" | "permission" | "review" | "idle" | string;
	/** Not started yet: waiting for room on this computer or the host. */
	queued?: boolean;
	/** Put down on purpose. */
	parked?: boolean;
	/** Ping me is on and nobody answered, or its task sits in Waiting on others. */
	waitingOn?: string | null;
	/** Catch up's call: only a merge, or nothing, is left. */
	almostDone?: boolean;
	/** The brief's word on the latest reply. */
	urgency?: "needs-you" | "fyi" | null;
}

export function todayGroup(s: TodaySignals): TodayGroup {
	if (s.column === "working" || s.queued) return "running";
	if (s.waitingOn != null) return "waiting";
	if (s.almostDone) return "almost-done";
	if (s.column === "permission") return "needs-you";
	if (s.column === "review")
		return s.urgency === "fyi" ? "almost-done" : "needs-you";
	return "paused";
}

export interface TodayEntry {
	key: string;
	group: TodayGroup;
	/** Local `YYYY-MM-DD`, from the linked task. */
	due?: string | null;
	urgency?: "high" | "medium" | "low" | null;
	starred?: boolean;
}

const URGENCY_RANK = { high: 0, medium: 1, low: 2 } as const;

/**
 * Groups in TODAY_GROUPS order, empty ones dropped. Inside a group: dated
 * work first, the nearest date first (overdue on top), then high priority,
 * then starred, then the board's own order.
 */
export function todayGroups<T extends TodayEntry>(
	entries: T[],
): { group: TodayGroup; items: T[] }[] {
	const sorted = entries
		.map((entry, i) => ({ entry, i }))
		.sort((a, b) => {
			const da = a.entry.due ?? "￿";
			const db = b.entry.due ?? "￿";
			if (da !== db) return da < db ? -1 : 1;
			const ua = a.entry.urgency ? URGENCY_RANK[a.entry.urgency] : 3;
			const ub = b.entry.urgency ? URGENCY_RANK[b.entry.urgency] : 3;
			if (ua !== ub) return ua - ub;
			const sa = a.entry.starred ? 0 : 1;
			const sb = b.entry.starred ? 0 : 1;
			return sa - sb || a.i - b.i;
		})
		.map(({ entry }) => entry);
	return TODAY_GROUPS.map(({ id }) => ({
		group: id,
		items: sorted.filter((entry) => entry.group === id),
	})).filter(({ items }) => items.length > 0);
}

/** Which groups the page shows: the chips' toggles, kept between visits. */
export interface TodayFilter {
	/** Groups toggled off: their section shrinks to its heading line. */
	hidden: readonly TodayGroup[];
	/** Due or overdue: only cards with a due date, in every group. */
	dueOnly: boolean;
}

/**
 * Every group in TODAY_GROUPS order, empty ones kept: `count` is how many
 * cards it holds under the due filter, `items` what the page lists (none
 * when the group is hidden), sorted as todayGroups sorts them.
 */
export function todaySections<T extends TodayEntry>(
	entries: T[],
	filter: TodayFilter,
): { group: TodayGroup; items: T[]; count: number; hidden: boolean }[] {
	const kept = filter.dueOnly
		? entries.filter((entry) => !!entry.due)
		: entries;
	const sorted = todayGroups(kept);
	return TODAY_GROUPS.map(({ id }) => {
		const items = sorted.find((g) => g.group === id)?.items ?? [];
		const hidden = filter.hidden.includes(id);
		return {
			group: id,
			items: hidden ? [] : items,
			count: items.length,
			hidden,
		};
	});
}

/** Hide a shown group, show a hidden one; kept in TODAY_GROUPS order. */
export function toggleTodayGroup(
	hidden: readonly TodayGroup[],
	group: TodayGroup,
): TodayGroup[] {
	const next = hidden.includes(group)
		? hidden.filter((g) => g !== group)
		: [...hidden, group];
	return TODAY_GROUPS.map((g) => g.id).filter((id) => next.includes(id));
}

/**
 * A group's chip: on a shown group it hides it; on a hidden one it shows it
 * and the page jumps to it.
 */
export function pressTodayChip(
	hidden: readonly TodayGroup[],
	group: TodayGroup,
): { hidden: TodayGroup[]; jump: boolean } {
	return {
		hidden: toggleTodayGroup(hidden, group),
		jump: hidden.includes(group),
	};
}

/** "3 need you, 2 running, 1 waiting on someone" - the top line before the model's. */
export function todayCounts(entries: { group: TodayGroup }[]): string {
	const count = (id: TodayGroup) =>
		entries.filter((e) => e.group === id).length;
	const parts = [
		[count("needs-you"), "need you", "needs you"],
		[count("almost-done"), "almost done", "almost done"],
		[count("running"), "running", "running"],
		[count("waiting"), "waiting on someone", "waiting on someone"],
		[count("paused"), "on hold", "on hold"],
	] as const;
	const said = parts
		.filter(([n]) => n > 0)
		.map(([n, many, one]) => `${n} ${n === 1 ? one : many}`);
	return said.length ? said.join(", ") : "Nothing open";
}

/** The due mark beside a row: Overdue, Due today, Due tomorrow, Due in N days, Due <date>. */
export function dueLabel(due: string, daysLeft: number): string {
	if (daysLeft < 0) return "Overdue";
	if (daysLeft === 0) return "Due today";
	if (daysLeft === 1) return "Due tomorrow";
	if (daysLeft < 7) return `Due in ${daysLeft} days`;
	return `Due ${due}`;
}

/**
 * A brief's line made fit to read on its own until the model's comes back:
 * PR and ticket numbers, links and hashes left out.
 */
export function plainLine(text: string | null | undefined): string {
	return (text ?? "")
		.replace(/\s*\([^()]*https?:\/\/[^()]*\)/g, "")
		.replace(/https?:\/\/\S+/g, "")
		.replace(/\b(?:PR|pull request)\s*#?\d+\b/gi, "the pull request")
		.replace(/\bissue\s*#?\d+\b/gi, "the issue")
		.replace(/\s*\(?#\d+\)?/g, "")
		.replace(/\b[A-Z][A-Z0-9]{1,9}-\d+\b:?\s*/g, "")
		.replace(/\b[0-9a-f]{7,40}\b/g, "")
		.replace(/\s+([,.;:])/g, "$1")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/** Show it now: on, something open, and not shown yet today. */
export function shouldShowToday({
	enabled,
	lastShown,
	today,
	count,
}: {
	enabled: boolean;
	lastShown: string | null;
	today: string;
	count: number;
}): boolean {
	return enabled && count > 0 && lastShown !== today;
}
