import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	dayOf,
	daysUntil,
	DueChip,
	dueLabel,
	dueToFire,
	dueTone,
	isDue,
	useReminders,
} from "./Reminders";

/** Late enough in the day that UTC has already rolled over east of Greenwich. */
const LATE_TODAY = new Date(2026, 8, 22, 23, 30).getTime(); // Tue 22 Sep 2026

test("today is the local day, not the UTC one", () => {
	expect(dayOf(LATE_TODAY)).toBe("2026-09-22");
});

test("a date reads as days from today, in whole local days", () => {
	expect(daysUntil("2026-09-22", LATE_TODAY)).toBe(0);
	expect(daysUntil("2026-09-23", LATE_TODAY)).toBe(1);
	expect(daysUntil("2026-09-20", LATE_TODAY)).toBe(-2);
	// Across a DST change the two days aren't 24h apart; it's still one day.
	expect(daysUntil("2026-10-25", new Date(2026, 9, 24, 12).getTime())).toBe(1);
});

test("how a due date reads and looks", () => {
	for (const [due, tone, label] of [
		["2026-09-20", "overdue", "Sep 20"],
		["2026-09-21", "overdue", "Yesterday"],
		["2026-09-22", "today", "Today"],
		["2026-09-23", "soon", "Tomorrow"],
		["2026-09-30", "later", "Sep 30"],
	] as const) {
		expect(dueTone(due, LATE_TODAY)).toBe(tone);
		expect(dueLabel(due, LATE_TODAY)).toBe(label);
	}
});

test("due means today or past — tomorrow isn't due yet", () => {
	const reminders = {
		"jira:BUGT-1": { due: "2026-09-20", title: "late" },
		"jira:BUGT-2": { due: "2026-09-22", title: "today" },
		"jira:BUGT-3": { due: "2026-09-23", title: "tomorrow" },
	};
	expect(isDue("jira:BUGT-1", reminders, LATE_TODAY)).toBe(true);
	expect(isDue("jira:BUGT-3", reminders, LATE_TODAY)).toBe(false);
	expect(isDue("jira:BUGT-9", reminders, LATE_TODAY)).toBe(false);
});

test("a row pings once a day, and again the next day it's still late", () => {
	const reminders = {
		"jira:BUGT-1": { due: "2026-09-20", title: "late" },
		"jira:BUGT-2": { due: "2026-09-22", title: "today" },
		"jira:BUGT-3": { due: "2026-09-23", title: "tomorrow" },
	};
	expect(dueToFire(reminders, {}, LATE_TODAY)).toEqual([
		"jira:BUGT-1",
		"jira:BUGT-2",
	]);
	// Pinged today: silent until tomorrow, when the overdue one speaks again.
	const notified = { "jira:BUGT-1": "2026-09-22", "jira:BUGT-2": "2026-09-22" };
	expect(dueToFire(reminders, notified, LATE_TODAY)).toEqual([]);
	const tomorrow = new Date(2026, 8, 23, 9).getTime();
	expect(dueToFire(reminders, notified, tomorrow)).toEqual([
		"jira:BUGT-1",
		"jira:BUGT-2",
		"jira:BUGT-3",
	]);
});

/**
 * An undated row offers a date, and the OS picker is the control. Only the
 * empty chip is rendered here: renderToStaticMarkup reads a zustand store
 * through `getInitialState`, so a seeded one renders empty anyway — what the
 * chip says once a date is on it is `dueLabel`/`dueTone`, tested above.
 */
test("the chip offers a date, with the native picker behind it", () => {
	const html = renderToStaticMarkup(
		<DueChip itemKey="jira:BUGT-1" title="BUGT-1: crash" />,
	);
	expect(html).toContain("+ due");
	expect(html).toContain('type="date"');
});
