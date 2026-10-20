import { describe, expect, test } from "bun:test";
import {
	type IdleArrivalInput,
	onIdleArrival,
	restoreAfterCompact,
} from "./idle-compact";

const HOUR = 60 * 60_000;
const NOW = 10 * HOUR;
const input = (overrides: Partial<IdleArrivalInput> = {}) => ({
	enabled: true,
	isAgent: true,
	alive: true,
	looping: false,
	open: false,
	...overrides,
});

describe("onIdleArrival", () => {
	test("a session parked in Idle is compacted on arrival", () => {
		expect(
			onIdleArrival(
				{ status: "idle", odinParked: true, odinStatusAt: NOW },
				input(),
			),
		).toBe("compact");
	});

	test("a Done session put under Waiting on others is compacted too", () => {
		expect(
			onIdleArrival({ status: "review", odinStatusAt: NOW }, input()),
		).toBe("compact");
	});

	test("off in Settings lets the arrival go", () => {
		expect(
			onIdleArrival(
				{ status: "idle", odinParked: true },
				input({ enabled: false }),
			),
		).toBe("skip");
	});

	test("an open drawer holds the arrival for when it closes", () => {
		expect(
			onIdleArrival(
				{ status: "idle", odinParked: true },
				input({ open: true }),
			),
		).toBe("hold");
	});

	test("once per turn - compacted already and nothing ran since", () => {
		const pane = {
			status: "idle" as const,
			odinParked: true,
			odinCompactedAt: NOW - 60_000,
		};
		expect(onIdleArrival(pane, input())).toBe("skip");
		// Not held either: the drawer closing would change nothing.
		expect(onIdleArrival(pane, input({ open: true }))).toBe("skip");
	});

	test("a loop, a queue, a dead or foreign pane all let it go", () => {
		const pane = { status: "idle" as const, odinParked: true };
		expect(onIdleArrival(pane, input({ looping: true }))).toBe("skip");
		expect(onIdleArrival(pane, input({ alive: false }))).toBe("skip");
		expect(onIdleArrival(pane, input({ isAgent: false }))).toBe("skip");
		expect(
			onIdleArrival(
				{ ...pane, odinQueued: { command: "claude", reason: "busy" } },
				input(),
			),
		).toBe("skip");
		// A dead session with its drawer open is still dead - nothing to wait for.
		expect(onIdleArrival(pane, input({ alive: false, open: true }))).toBe(
			"skip",
		);
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
