import { describe, expect, test } from "bun:test";
import { cheerFor, weekStart } from "./cheer";

const DAY = 86_400_000;
// A Wednesday, mid-week.
const now = new Date(2026, 10, 11, 12).getTime();
const thisWeek = weekStart(now);
const lastWeek = weekStart(thisWeek - DAY);
const twoAgo = weekStart(lastWeek - DAY);

const week = (
	start: number,
	shipped: number,
	parallel: number | null = null,
) => ({
	start,
	shipped,
	parallel,
});

describe("cheerFor", () => {
	test("cheers more merged PRs than the week before", () => {
		const msg = cheerFor(
			[week(twoAgo, 4), week(lastWeek, 6), week(thisWeek, 0)],
			now,
		);
		expect(msg).toContain("6 PRs");
		expect(msg).toContain("50% more");
	});

	test("cheers a first real week after an empty one", () => {
		expect(cheerFor([week(twoAgo, 0), week(lastWeek, 3)], now)).toContain(
			"up from 0",
		);
	});

	test("says nothing when merges went down or stayed", () => {
		expect(cheerFor([week(twoAgo, 6), week(lastWeek, 4)], now)).toBeNull();
		expect(cheerFor([week(twoAgo, 4), week(lastWeek, 4)], now)).toBeNull();
	});

	test("cheers more agents at once when merges held", () => {
		const msg = cheerFor([week(twoAgo, 3, 1.5), week(lastWeek, 3, 2.4)], now);
		expect(msg).toContain("2.4 agents at once");
	});

	test("ignores the week still going, and a stale or gapped history", () => {
		expect(cheerFor([week(lastWeek, 1), week(thisWeek, 9)], now)).toBeNull();
		expect(
			cheerFor([week(twoAgo - 7 * DAY, 1), week(twoAgo, 5)], now),
		).toBeNull();
		expect(
			cheerFor([week(twoAgo - 7 * DAY, 1), week(lastWeek, 5)], now),
		).toBeNull();
	});

	test("calls a new best week an all-time high", () => {
		const history = [
			week(twoAgo - 14 * DAY, 5),
			week(twoAgo - 7 * DAY, 8),
			week(twoAgo, 3),
			week(lastWeek, 9),
		];
		expect(cheerFor(history, now)).toContain("all-time high");
		expect(cheerFor(history, now)).toContain("record was 8");
	});

	test("no all-time high without a few weeks, or when it only ties", () => {
		expect(cheerFor([week(twoAgo, 3), week(lastWeek, 9)], now)).not.toContain(
			"all-time high",
		);
		const tie = [
			week(twoAgo - 14 * DAY, 5),
			week(twoAgo - 7 * DAY, 9),
			week(twoAgo, 3),
			week(lastWeek, 9),
		];
		expect(cheerFor(tie, now)).not.toContain("all-time high");
	});
});
