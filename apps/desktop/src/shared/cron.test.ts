import { describe, expect, test } from "bun:test";
import {
	cronMatches,
	cronOf,
	DEFAULT_SCHEDULE,
	describeCron,
	isValidCron,
	nextRun,
	parseCron,
	scheduleOf,
} from "./cron";

/** Local time, because that's what the scheduler compares against. */
const at = (iso: string) => new Date(iso);

const fires = (expr: string, iso: string) => {
	const cron = parseCron(expr);
	if (!cron) throw new Error(`not a cron: ${expr}`);
	return cronMatches(cron, at(iso));
};

describe("parseCron", () => {
	test("rejects anything that isn't five fields", () => {
		expect(parseCron("")).toBeNull();
		expect(parseCron("0 9 * *")).toBeNull();
		expect(parseCron("0 9 * * * *")).toBeNull();
		expect(parseCron("every day")).toBeNull();
	});

	test("rejects out-of-range and malformed fields", () => {
		expect(parseCron("60 * * * *")).toBeNull();
		expect(parseCron("* 24 * * *")).toBeNull();
		expect(parseCron("* * 0 * *")).toBeNull();
		expect(parseCron("* * * 13 *")).toBeNull();
		expect(parseCron("* * * * 8")).toBeNull();
		expect(parseCron("*/0 * * * *")).toBeNull();
		expect(parseCron("9-5 * * * *")).toBeNull();
		expect(parseCron("a * * * *")).toBeNull();
	});

	test("takes the @shorthands", () => {
		expect(isValidCron("@daily")).toBe(true);
		expect(isValidCron("@hourly")).toBe(true);
		expect(fires("@daily", "2026-09-20T00:00")).toBe(true);
		expect(fires("@daily", "2026-09-20T09:00")).toBe(false);
	});
});

describe("cronMatches", () => {
	test("a plain daily time", () => {
		expect(fires("30 9 * * *", "2026-09-20T09:30")).toBe(true);
		expect(fires("30 9 * * *", "2026-09-20T09:31")).toBe(false);
		expect(fires("30 9 * * *", "2026-09-20T10:30")).toBe(false);
	});

	test("steps, ranges and lists", () => {
		expect(fires("*/15 * * * *", "2026-09-20T10:45")).toBe(true);
		expect(fires("*/15 * * * *", "2026-09-20T10:46")).toBe(false);
		// 2026-09-21 is a Monday, 2026-09-20 a Sunday.
		expect(fires("0 9 * * 1-5", "2026-09-21T09:00")).toBe(true);
		expect(fires("0 9 * * 1-5", "2026-09-20T09:00")).toBe(false);
		expect(fires("0 8,17 * * *", "2026-09-20T17:00")).toBe(true);
		expect(fires("0 8,17 * * *", "2026-09-20T12:00")).toBe(false);
	});

	test("Sunday is both 0 and 7", () => {
		expect(fires("0 9 * * 7", "2026-09-20T09:00")).toBe(true);
		expect(fires("0 9 * * 0", "2026-09-20T09:00")).toBe(true);
		// 5-7 is Fri..Sun, not an inverted range.
		expect(fires("0 9 * * 5-7", "2026-09-20T09:00")).toBe(true);
		expect(fires("0 9 * * 5-7", "2026-09-21T09:00")).toBe(false);
	});

	test("day-of-month and day-of-week are OR'd when both are set", () => {
		// The 1st (a Tuesday) or any Monday.
		expect(fires("0 9 1 * 1", "2026-09-01T09:00")).toBe(true);
		expect(fires("0 9 1 * 1", "2026-09-21T09:00")).toBe(true);
		expect(fires("0 9 1 * 1", "2026-09-22T09:00")).toBe(false);
		// Only one of them set means it's the only one that counts.
		expect(fires("0 9 1 * *", "2026-09-21T09:00")).toBe(false);
	});
});

describe("nextRun", () => {
	test("is the next matching minute, never the one it started on", () => {
		expect(nextRun("30 9 * * *", at("2026-09-20T09:00"))?.toISOString()).toBe(
			at("2026-09-20T09:30").toISOString(),
		);
		expect(nextRun("30 9 * * *", at("2026-09-20T09:30"))?.toISOString()).toBe(
			at("2026-09-21T09:30").toISOString(),
		);
	});

	test("null for a bad expression and for one that can never fire", () => {
		expect(nextRun("nope", at("2026-09-20T09:00"))).toBeNull();
		expect(nextRun("0 9 30 2 *", at("2026-09-20T09:00"))).toBeNull();
	});
});

describe("the picker's schedules", () => {
	const roundTrip = (expr: string) => {
		const s = scheduleOf(expr);
		return s ? cronOf(s) : null;
	};

	test("every shape the picker offers survives the round trip", () => {
		for (const expr of [
			"*/15 * * * *",
			"*/30 * * * *",
			"0 * * * *",
			"30 9 * * *",
			"0 9 * * 1,2,3,4,5",
			"0 9 * * 1,3,5",
			"15 17 * * 5",
			"0 8 12 * *",
		]) {
			expect(roundTrip(expr)).toBe(expr);
		}
	});

	test("a day range opens as the days it means", () => {
		// Written by hand, or by an older build — it lights Mon-Fri rather than
		// dropping the whole thing into the Custom box.
		expect(scheduleOf("0 9 * * 1-5")).toMatchObject({
			repeat: "days",
			weekdays: [1, 2, 3, 4, 5],
		});
		// Sunday is 0 or 7, and both spellings light the same toggle.
		expect(scheduleOf("0 9 * * 7")?.weekdays).toEqual([0]);
		// Fri-Sun, not an inverted 5..0.
		expect(scheduleOf("0 9 * * 5-7")?.weekdays).toEqual([0, 5, 6]);
		expect(scheduleOf("0 9 * * 6,0")?.weekdays).toEqual([0, 6]);
	});

	test("a cron the picker can't express reads as custom, not as a near miss", () => {
		// :15 past the hour is NOT "every hour" — rendering it as one would
		// save the minute away.
		expect(scheduleOf("15 * * * *")).toBeNull();
		expect(scheduleOf("0 9 * * 8")).toBeNull();
		expect(scheduleOf("0 9 * * 1-5/2")).toBeNull();
		expect(scheduleOf("0 9 31 * *")).toBeNull();
		expect(scheduleOf("0 9 * 3 *")).toBeNull();
		expect(scheduleOf("0 9 1 * 1")).toBeNull();
		expect(scheduleOf("not a cron")).toBeNull();
	});

	test("the @shorthands come back as pickable schedules", () => {
		expect(scheduleOf("@hourly")?.repeat).toBe("hourly");
		expect(scheduleOf("@daily")).toMatchObject({
			repeat: "daily",
			time: "00:00",
		});
		expect(scheduleOf("@weekly")).toMatchObject({
			repeat: "days",
			weekdays: [0],
		});
		expect(scheduleOf("@monthly")).toMatchObject({ repeat: "monthly", day: 1 });
	});

	test("describeCron says it in words, or gives the cron back", () => {
		expect(describeCron("*/30 * * * *")).toBe("every 30 minutes");
		expect(describeCron("0 * * * *")).toBe("every hour, on the hour");
		expect(describeCron("30 9 * * *")).toBe("every day at 09:30");
		expect(describeCron("0 9 * * 1-5")).toBe("weekdays at 09:00");
		expect(describeCron("0 9 * * 1,3,5")).toBe("Mon, Wed & Fri at 09:00");
		expect(describeCron("0 9 * * 0,6")).toBe("weekends at 09:00");
		expect(describeCron("15 17 * * 5")).toBe("every Friday at 17:15");
		expect(describeCron("0 8 22 * *")).toBe("on the 22nd at 08:00");
		expect(describeCron("0 9 1 * 1")).toBe("0 9 1 * 1");
	});

	test("what the picker writes is always a cron the matcher accepts", () => {
		for (const repeat of [
			"15m",
			"30m",
			"hourly",
			"daily",
			"days",
			"monthly",
		] as const) {
			const expr = cronOf({
				...DEFAULT_SCHEDULE,
				repeat,
				time: "07:05",
				weekdays: [5, 1, 1, 3],
				day: 28,
			});
			expect(isValidCron(expr)).toBe(true);
		}
	});
});
