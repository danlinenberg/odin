import { describe, expect, test } from "bun:test";
import { revealRow, rowPlace } from "./reveal-row";

/** A row or the panel, as far as revealRow touches it. */
function element() {
	const calls: { scroll: unknown[]; animate: unknown[][] } = {
		scroll: [],
		animate: [],
	};
	return {
		calls,
		scrollIntoView: (...args: unknown[]) => calls.scroll.push(args),
		animate: (...args: unknown[]) => calls.animate.push(args),
	};
}

function root(found: Record<string, ReturnType<typeof element>>) {
	const asked: string[] = [];
	return {
		asked,
		querySelector: (selector: string) => {
			asked.push(selector);
			return found[selector] ?? null;
		},
	};
}

const settlesOn = (el: ReturnType<typeof element>) =>
	(el.calls.animate[0]?.[0] as { backgroundColor: string }[]).at(-1)
		?.backgroundColor;

describe("revealRow", () => {
	test("scrolls the row to the middle and flashes it and the panel", () => {
		const row = element();
		const panel = element();
		const dom = root({
			'[data-task-row="task:1"]': row,
			"[data-task-panel]": panel,
		});
		expect(revealRow("task:1", dom)).toBe(true);
		expect(row.calls.scroll).toEqual([
			[{ block: "center", behavior: "smooth" }],
		]);
		// The row's flash settles on its open tint, the panel's on nothing.
		expect(settlesOn(row)).toContain("12%");
		expect(settlesOn(panel)).toContain("0%");
	});

	test("with no row on screen, only the panel flashes", () => {
		const panel = element();
		expect(revealRow("task:1", root({ "[data-task-panel]": panel }))).toBe(
			false,
		);
		expect(panel.calls.animate).toHaveLength(1);
	});

	test("a key with a quote in it is still a valid selector", () => {
		const dom = root({});
		revealRow('slack:say "hi"', dom);
		expect(dom.asked).toContain('[data-task-row="slack:say \\"hi\\""]');
	});
});

test("rowPlace says whether the open row is listed, and if not, why", () => {
	const at = {
		listed: new Set(["task:1"]),
		all: new Set(["task:1", "jira:A-2"]),
	};
	expect(rowPlace("task:1", { ...at, done: false })).toBe("listed");
	expect(rowPlace("jira:A-2", { ...at, done: false })).toBe("filtered");
	expect(rowPlace("pr:3", { ...at, done: true })).toBe("done");
	expect(rowPlace("pr:3", { ...at, done: false })).toBe("elsewhere");
});
