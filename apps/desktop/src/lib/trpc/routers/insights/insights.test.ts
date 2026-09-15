import { describe, expect, test } from "bun:test";
import { type AskRow, computeInsights, median } from "./insights";

const HOUR = 3_600_000;

function ask(over: Partial<AskRow> = {}): AskRow {
	return {
		firstSeenAt: 0,
		startedAt: null,
		doneAt: null,
		unreactedAt: null,
		authorName: null,
		...over,
	};
}

describe("median", () => {
	test("odd count takes the middle", () => {
		expect(median([5, 1, 3])).toBe(3);
	});
	test("even count averages the two middles", () => {
		expect(median([1, 2, 3, 4])).toBe(2.5);
	});
	test("nothing to average is null, not zero", () => {
		expect(median([])).toBeNull();
	});
});

describe("computeInsights", () => {
	test("counts what landed, what was picked up, what is still sitting", () => {
		const result = computeInsights(
			[
				ask({ startedAt: 1 }),
				ask({ doneAt: 1 }),
				ask(),
				// Reaction removed: withdrawn, not ignored — not counted as waiting.
				ask({ unreactedAt: 1 }),
			],
			[],
		);
		expect(result.seen).toBe(4);
		expect(result.delegated).toBe(1);
		expect(result.done).toBe(1);
		expect(result.waiting).toBe(1);
	});

	test("pickup time is the median, so one overnight thread can't swamp it", () => {
		const result = computeInsights(
			[
				ask({ firstSeenAt: 0, startedAt: 0 }),
				ask({ firstSeenAt: 0, startedAt: HOUR }),
				ask({ firstSeenAt: 0, startedAt: 15 * HOUR }),
			],
			[],
		);
		expect(result.medianPickupHours).toBe(1);
		expect(result.slowestPickupHours).toBe(15);
	});

	test("a start recorded before the sighting doesn't go negative", () => {
		const result = computeInsights(
			[ask({ firstSeenAt: 5 * HOUR, startedAt: 4 * HOUR })],
			[],
		);
		expect(result.medianPickupHours).toBe(0);
	});

	test("no pickups yet reads as null, not 0 hours", () => {
		const result = computeInsights([ask(), ask()], []);
		expect(result.medianPickupHours).toBeNull();
		expect(result.slowestPickupHours).toBeNull();
	});

	test("askers and sources rank biggest first", () => {
		const result = computeInsights(
			[
				ask({ authorName: "Maya" }),
				ask({ authorName: "Maya" }),
				ask({ authorName: "Ofek" }),
				ask({ authorName: null }),
			],
			[
				{ source: "jira", person: null, startedAt: 1 },
				{ source: "reactions", person: null, startedAt: 2 },
				{ source: "jira", person: null, startedAt: 3 },
			],
		);
		expect(result.askers).toEqual([
			{ name: "Maya", asks: 2 },
			{ name: "Ofek", asks: 1 },
		]);
		expect(result.bySource).toEqual([
			{ source: "jira", count: 2 },
			{ source: "reactions", count: 1 },
		]);
		expect(result.delegationsLogged).toBe(3);
	});
});
