/**
 * Where the row the side panel shows stands, relative to the list beside it:
 * in it, cut by the filters, Done'd, or left out of All altogether (your own
 * PR, a ticket you filed, a started Slack thread) and so on its own tab.
 */
export type RowPlace = "listed" | "filtered" | "done" | "elsewhere";

export function rowPlace(
	key: string,
	{
		listed,
		all,
		done,
	}: {
		/** The keys of the rows on screen right now. */
		listed: ReadonlySet<string>;
		/** The keys of every row All holds, before the filters. */
		all: ReadonlySet<string>;
		/** Done'd in Odin, or closed upstream. */
		done: boolean;
	},
): RowPlace {
	if (listed.has(key)) return "listed";
	if (all.has(key)) return "filtered";
	return done ? "done" : "elsewhere";
}

/** What revealRow needs of an element, so a test can hand it a stand-in. */
interface Revealable {
	scrollIntoView(options: ScrollIntoViewOptions): void;
	animate(
		keyframes: { backgroundColor: string }[],
		options: { duration: number; easing: string },
	): unknown;
}

interface Root {
	querySelector(selector: string): Revealable | null;
}

const tint = (percent: number) =>
	`color-mix(in oklab, var(--primary) ${percent}%, transparent)`;

/** A short flash of primary, fading to the element's resting tint. */
function flash(target: Revealable, restAt: number) {
	target.animate(
		[{ backgroundColor: tint(35) }, { backgroundColor: tint(restAt) }],
		{ duration: 1800, easing: "ease-out" },
	);
}

/**
 * How a pick in Search all lands on the Tasks page: the side panel flashes so
 * it reads as newly opened, and the row it shows scrolls to the middle of the
 * list and flashes too, settling on its open tint (bg-primary/12 in
 * TaskTable.tsx). False when the row isn't on screen - the filters hide it,
 * or All leaves it out - and the panel says where it is instead.
 */
export function revealRow(key: string, root: Root = document): boolean {
	const panel = root.querySelector("[data-task-panel]");
	if (panel) flash(panel, 0);
	const quoted = key.replace(/["\\]/g, "\\$&");
	const row = root.querySelector(`[data-task-row="${quoted}"]`);
	if (!row) return false;
	row.scrollIntoView({ block: "center", behavior: "smooth" });
	flash(row, 12);
	return true;
}
