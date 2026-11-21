import {
	isAnswerItem,
	isApprovalItem,
	isDoneItem,
	itemOptions,
} from "./action-items";

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

/** Quick wins before questions: a merge or a look takes seconds. */
const LANE_RANK: Record<TodayGroup, number> = {
	"almost-done": 0,
	"needs-you": 1,
	running: 2,
	waiting: 3,
	paused: 4,
};

/**
 * The order to do things in, across groups: overdue or due today first,
 * then what is almost done (seconds of work), then what needs you, then the
 * rest. Inside that, the nearest due date, high priority, star, board order.
 * Without `today`, no date counts as due now.
 */
export function rankToday<T extends TodayEntry>(entries: T[], today = ""): T[] {
	const now = (entry: T) => (entry.due && entry.due <= today ? 0 : 1);
	return entries
		.map((entry, i) => ({ entry, i }))
		.sort((a, b) => {
			const na = now(a.entry);
			const nb = now(b.entry);
			if (na !== nb) return na - nb;
			const ga = LANE_RANK[a.entry.group];
			const gb = LANE_RANK[b.entry.group];
			if (ga !== gb) return ga - gb;
			const da = a.entry.due ?? "\uffff";
			const db = b.entry.due ?? "\uffff";
			if (da !== db) return da < db ? -1 : 1;
			const ua = a.entry.urgency ? URGENCY_RANK[a.entry.urgency] : 3;
			const ub = b.entry.urgency ? URGENCY_RANK[b.entry.urgency] : 3;
			if (ua !== ub) return ua - ub;
			const sa = a.entry.starred ? 0 : 1;
			const sb = b.entry.starred ? 0 : 1;
			return sa - sb || a.i - b.i;
		})
		.map(({ entry }) => entry);
}

/** A task as the model wrote it: the sessions' keys, and its words. */
export interface WrittenTask {
	keys: string[];
	name: string;
	about: string | null;
	explain?: string | null;
	line: string | null;
	left?: string | null;
	next?: string | null;
}

/** A task as the page lists it: its words and the open sessions it holds. */
export interface TodayTaskView<T> {
	/** Its first session's key: stable while that session is open. */
	id: string;
	name: string;
	about: string | null;
	/** The task explained for someone who never saw it. */
	explain: string | null;
	/** Where it stands; the brief's status line until the model's is written. */
	line: string | null;
	/** What is left before it is done. */
	left: string | null;
	/** Who acts next and what. */
	next: string | null;
	/** Its sessions, the one to look at first on top. */
	items: T[];
	/** Where its most pressing session stands. */
	group: TodayGroup;
}

/**
 * The page's tasks: the model's grouping over the sessions open now. A
 * session it left out (it is new, or the answer is not back yet) is a task
 * of its own, titled by the session, its brief's status as the line. Tasks
 * come in the order rankToday ranks their most pressing session.
 */
export function todayTasks<
	T extends TodayEntry & {
		title: string;
		status?: string | null;
		/** The session's goal from its brief: what it is about, until the model says. */
		goal?: string | null;
	},
>(written: readonly WrittenTask[], items: T[], today = ""): TodayTaskView<T>[] {
	const ranked = rankToday(items, today);
	const rank = new Map(ranked.map((item, i) => [item.key, i]));
	const byKey = new Map(items.map((item) => [item.key, item]));
	const taken = new Set<string>();
	const tasks: Omit<TodayTaskView<T>, "id" | "group">[] = [];
	for (const task of written) {
		const mine = task.keys
			.map((key) => byKey.get(key))
			.filter((item): item is T => !!item && !taken.has(item.key));
		if (!mine.length) continue;
		for (const item of mine) taken.add(item.key);
		tasks.push({
			name: task.name,
			about: task.about ?? mine.find((item) => item.goal)?.goal ?? null,
			explain: task.explain ?? null,
			line: task.line,
			left: task.left ?? null,
			next: task.next ?? null,
			items: mine,
		});
	}
	for (const item of items)
		if (!taken.has(item.key))
			tasks.push({
				name: item.title,
				about: item.goal ?? null,
				explain: null,
				line: plainLine(item.status) || null,
				left: null,
				next: null,
				items: [item],
			});
	const at = (item: T) => rank.get(item.key) ?? ranked.length;
	return tasks
		.map((task) => {
			const sorted = [...task.items].sort((a, b) => at(a) - at(b));
			return {
				...task,
				items: sorted,
				id: sorted[0].key,
				group: sorted[0].group,
			};
		})
		.sort((a, b) => at(a.items[0]) - at(b.items[0]));
}

/** "You: pick the email wording" -> "Pick the email wording"; null when someone else acts next. */
export function yourAction(next: string | null | undefined): string | null {
	const said = /^you\s*:\s*(.+?)\.?$/i.exec(next?.trim() ?? "");
	if (!said) return null;
	return said[1][0].toUpperCase() + said[1].slice(1);
}

/** What an action item asks of you, as a one-word chip. */
export function itemKind(item: string): string {
	if (isApprovalItem(item)) return "Approve";
	if (isDoneItem(item)) return "Confirm";
	if (isAnswerItem(item) || itemOptions(item).options.length) return "Answer";
	if (/\bmerge\b/i.test(item)) return "Merge";
	return "Do";
}

/**
 * A card's title: the session's first action item (its own words, cut at a
 * word near 120 characters), else the model's next step when it is yours,
 * else the task's name ("Finish: name" when only a merge or a look is left).
 */
export function todayTitle(
	task: { name: string; group: TodayGroup; next: string | null },
	firstItem?: string | null,
): string {
	const item = firstItem ? itemOptions(firstItem).text.trim() : "";
	if (item)
		return item.length > 120
			? `${item.slice(0, 120).replace(/\s+\S*$/, "")}...`
			: item;
	return (
		yourAction(task.next) ??
		(task.group === "almost-done" ? `Finish: ${task.name}` : task.name)
	);
}

/**
 * The page's two lanes. Waiting on you: tasks that need you or only wait on
 * your merge, and any other task whose next step is yours. Moving without
 * you: the rest - Claude running, someone else, or on hold. Order is kept.
 */
export function todayLanes<
	T extends { group: TodayGroup; next: string | null },
>(tasks: T[]): { yours: T[]; moving: T[] } {
	const mine = (task: T) =>
		task.group === "needs-you" ||
		task.group === "almost-done" ||
		(task.group !== "running" && !!yourAction(task.next));
	return { yours: tasks.filter(mine), moving: tasks.filter((t) => !mine(t)) };
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
