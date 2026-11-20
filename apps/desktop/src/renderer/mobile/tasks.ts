/** A task as the board's backlog lists it. The away host sends only id and title. */
export interface PhoneTask {
	id: string;
	title: string;
	notes?: string;
	repo?: string;
	/** `YYYY-MM-DD`, the day it's wanted by. */
	due?: string;
	/** Its place on Up next, 0 first. */
	upNext?: number;
	/** 1-3, Low to High; absent reads as Medium. */
	priority?: number;
}

/** Up next in its order, then the rest by priority, High first; ties keep the list's order. */
export function taskSections<T extends PhoneTask>(tasks: T[]) {
	const upNext = tasks
		.filter((task) => task.upNext !== undefined)
		.sort((a, b) => (a.upNext ?? 0) - (b.upNext ?? 0));
	const rest = tasks
		.filter((task) => task.upNext === undefined)
		.sort((a, b) => (b.priority ?? 2) - (a.priority ?? 2));
	return [
		{ key: "upnext", label: "Up next", rows: upNext },
		{ key: "tasks", label: "Tasks", rows: rest },
	].filter((section) => section.rows.length > 0);
}

/** "Overdue", "Today", "Tomorrow", or the day, as the desktop row's chip reads. */
export function dueText(due: string, now: number) {
	const [y = 0, m = 1, d = 1] = due.split("-").map(Number);
	const day = new Date(y, m - 1, d);
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const days = Math.round((day.getTime() - today.getTime()) / 86_400_000);
	if (days < 0) return { text: "Overdue", late: true };
	if (days === 0) return { text: "Today", late: true };
	if (days === 1) return { text: "Tomorrow", late: false };
	return {
		text: day.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
		late: false,
	};
}
