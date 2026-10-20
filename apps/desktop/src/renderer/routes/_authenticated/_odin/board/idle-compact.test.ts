import { describe, expect, test } from "bun:test";
import {
	type CompactSweepInput,
	dueForCompact,
	restoreAfterCompact,
} from "./idle-compact";

const HOUR = 60 * 60_000;
const NOW = 10 * HOUR;
const input = (overrides: Partial<CompactSweepInput> = {}) => ({
	now: NOW,
	afterMs: 45 * 60_000,
	isAgent: true,
	alive: true,
	looping: false,
	open: false,
	firstSeen: NOW - 2 * HOUR,
	...overrides,
});

describe("dueForCompact", () => {
	test("a Done session that sat past the delay is due", () => {
		expect(
			dueForCompact({ status: "review", odinStatusAt: NOW - HOUR }, input()),
		).toBe(true);
	});

	test("a parked session is due too", () => {
		expect(
			dueForCompact(
				{ status: "idle", odinParked: true, odinStatusAt: NOW - HOUR },
				input(),
			),
		).toBe(true);
	});

	test("not before the delay", () => {
		expect(
			dueForCompact(
				{ status: "review", odinStatusAt: NOW - 10 * 60_000 },
				input(),
			),
		).toBe(false);
	});

	test("0 minutes turns it off", () => {
		expect(
			dueForCompact(
				{ status: "review", odinStatusAt: NOW - HOUR },
				input({ afterMs: 0 }),
			),
		).toBe(false);
	});

	test("a prompt someone is standing in is not free", () => {
		for (const status of ["permission", "failed", "working"] as const) {
			expect(dueForCompact({ status, odinStatusAt: NOW - HOUR }, input())).toBe(
				false,
			);
		}
	});

	test("alive-but-idle without a park may be mid-turn after a reload", () => {
		expect(
			dueForCompact({ status: "idle", odinStatusAt: NOW - HOUR }, input()),
		).toBe(false);
	});

	test("once per turn - compacted already and nothing ran since", () => {
		expect(
			dueForCompact(
				{
					status: "review",
					odinStatusAt: NOW - HOUR,
					odinCompactedAt: NOW - 50 * 60_000,
				},
				input(),
			),
		).toBe(false);
	});

	test("the drawer being open, a loop, a queue, a dead or foreign pane all wait", () => {
		const pane = { status: "review" as const, odinStatusAt: NOW - HOUR };
		expect(dueForCompact(pane, input({ open: true }))).toBe(false);
		expect(dueForCompact(pane, input({ looping: true }))).toBe(false);
		expect(dueForCompact(pane, input({ alive: false }))).toBe(false);
		expect(dueForCompact(pane, input({ isAgent: false }))).toBe(false);
		expect(
			dueForCompact(
				{ ...pane, odinQueued: { command: "claude", reason: "busy" } },
				input(),
			),
		).toBe(false);
	});

	test("no status stamp: the clock runs from when the board first saw it", () => {
		expect(
			dueForCompact({ status: "review" }, input({ firstSeen: NOW - HOUR })),
		).toBe(true);
		expect(
			dueForCompact(
				{ status: "review" },
				input({ firstSeen: NOW - 10 * 60_000 }),
			),
		).toBe(false);
	});
});

describe("restoreAfterCompact", () => {
	const before = {
		status: "idle" as const,
		odinParked: true,
		odinStatusAt: NOW - HOUR,
	};

	test("puts the card back where it was, park and clock included", () => {
		expect(
			restoreAfterCompact(before, { odinCompactedAt: NOW - 60_000 }),
		).toEqual(before);
	});

	test("nothing to restore once a real turn ran - the mark is gone", () => {
		expect(restoreAfterCompact(before, { odinCompactedAt: undefined })).toBe(
			null,
		);
		expect(restoreAfterCompact(before, undefined)).toBe(null);
	});
});
