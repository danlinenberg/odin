import { describe, expect, test } from "bun:test";
import { cronMatches, isValidCron, nextRun, parseCron } from "./cron";

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
