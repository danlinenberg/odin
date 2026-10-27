import { describe, expect, test } from "bun:test";
import type { NightLogEntry } from "renderer/stores/next-in-line-prompt";
import { featuredNight, groupNights, phoneNights } from "./night-log";

const ms = (iso: string) => new Date(iso).getTime();
const line = (iso: string, event: string, rest?: Partial<NightLogEntry>) => ({
	at: new Date(iso).toISOString(),
	event,
	...rest,
});
const started = (title: string) => ({
	key: title,
	title,
	source: "GitHub",
});

describe("groupNights", () => {
	test("lines on both sides of midnight are one night, newest first", () => {
		const nights = groupNights(
			[
				line("2026-10-18T23:05:00", "a"),
				line("2026-10-19T02:00:00", "b"),
				line("2026-10-19T06:59:00", "c"),
			],
			"23:00",
			"07:00",
			new Date("2026-10-19T09:00:00"),
		);
		expect(nights).toHaveLength(1);
		expect(nights[0]?.from).toBe(ms("2026-10-18T23:00:00"));
		expect(nights[0]?.to).toBe(ms("2026-10-19T07:00:00"));
		expect(nights[0]?.lines.map((l) => l.event)).toEqual(["c", "b", "a"]);
	});

	test("a daytime line joins the nearer night: just closed, or coming", () => {
		const nights = groupNights(
			[
				line("2026-10-19T07:01:00", "closed"),
				line("2026-10-19T20:00:00", "plan"),
			],
			"23:00",
			"07:00",
			new Date("2026-10-19T21:00:00"),
		);
		expect(nights.map((n) => [n.from, n.lines[0]?.event])).toEqual([
			[ms("2026-10-19T23:00:00"), "plan"],
			[ms("2026-10-18T23:00:00"), "closed"],
		]);
	});

	test("a line stamped with its night goes there whatever its time", () => {
		const nights = groupNights(
			[
				line("2026-10-19T10:00:00", "plan", {
					night: ms("2026-10-19T23:00:00"),
				}),
			],
			"23:00",
			"07:00",
			new Date("2026-10-19T11:00:00"),
		);
		expect(nights[0]?.from).toBe(ms("2026-10-19T23:00:00"));
		expect(nights[0]?.to).toBe(ms("2026-10-20T07:00:00"));
	});

	test("what it started, in start order, even when logged out of order", () => {
		const nights = groupNights(
			[
				line("2026-10-19T08:30:00", "ran: second", {
					at: new Date("2026-10-19T01:00:00").toISOString(),
					started: started("second"),
				}),
				line("2026-10-19T08:30:01", "ran: first", {
					at: new Date("2026-10-18T23:10:00").toISOString(),
					started: started("first"),
				}),
				line("2026-10-19T07:01:00", "closed"),
			],
			"23:00",
			"07:00",
			new Date("2026-10-19T09:00:00"),
		);
		expect(nights).toHaveLength(1);
		expect(nights[0]?.started.map((l) => l.started?.title)).toEqual([
			"first",
			"second",
		]);
		expect(nights[0]?.lines.map((l) => l.event)).toEqual([
			"closed",
			"ran: second",
			"ran: first",
		]);
	});

	test("labels: tonight, last night, then the date", () => {
		const nights = groupNights(
			[
				line("2026-10-16T23:30:00", "old"),
				line("2026-10-18T23:30:00", "last"),
				line("2026-10-19T23:30:00", "now"),
			],
			"23:00",
			"07:00",
			new Date("2026-10-20T01:00:00"),
		);
		expect(nights.map((n) => n.label)).toEqual([
			"Tonight",
			"Last night",
			new Date("2026-10-16T23:00:00").toLocaleDateString([], {
				weekday: "short",
				month: "short",
				day: "numeric",
			}),
		]);
	});

	test("in the morning, the night just over is last night", () => {
		const nights = groupNights(
			[line("2026-10-18T23:30:00", "x")],
			"23:00",
			"07:00",
			new Date("2026-10-19T08:00:00"),
		);
		expect(nights[0]?.label).toBe("Last night");
	});
});

describe("featuredNight", () => {
	const window = ["23:00", "07:00"] as const;

	test("in the morning: last night, from the log", () => {
		const nights = groupNights(
			[line("2026-10-18T23:30:00", "x")],
			...window,
			new Date("2026-10-19T09:00:00"),
		);
		const night = featuredNight(
			nights,
			...window,
			new Date("2026-10-19T09:00:00"),
		);
		expect(night).toBe(nights[0]);
		expect(night.label).toBe("Last night");
	});

	test("in the morning with nothing logged: an empty last night", () => {
		const night = featuredNight([], ...window, new Date("2026-10-19T09:00:00"));
		expect(night.from).toBe(ms("2026-10-18T23:00:00"));
		expect(night.label).toBe("Last night");
		expect(night.lines).toEqual([]);
		expect(night.started).toEqual([]);
	});

	test("inside the window: tonight", () => {
		const now = new Date("2026-10-20T02:00:00");
		const nights = groupNights(
			[line("2026-10-18T23:30:00", "old"), line("2026-10-19T23:30:00", "x")],
			...window,
			now,
		);
		const night = featuredNight(nights, ...window, now);
		expect(night.from).toBe(ms("2026-10-19T23:00:00"));
		expect(night.label).toBe("Tonight");
	});

	test("in the evening before the window: still last night", () => {
		const now = new Date("2026-10-19T21:00:00");
		const nights = groupNights(
			[
				line("2026-10-18T23:30:00", "ran"),
				line("2026-10-19T20:00:00", "plan", {
					night: ms("2026-10-19T23:00:00"),
				}),
			],
			...window,
			now,
		);
		expect(featuredNight(nights, ...window, now).from).toBe(
			ms("2026-10-18T23:00:00"),
		);
	});
});

describe("phoneNights", () => {
	test("a night's started sessions carry the pane still holding them", () => {
		const nights = phoneNights(
			[
				line("2026-10-18T23:05:00", "Started a", {
					started: { ...started("a"), sessionId: "s-a" },
				}),
				line("2026-10-19T01:00:00", "Started b", {
					started: { ...started("b"), sessionId: "s-b" },
				}),
				line("2026-10-19T07:01:00", "Window closed"),
			],
			{ start: "23:00", end: "07:00" },
			(sessionId) => (sessionId === "s-a" ? "pane-a" : undefined),
			new Date("2026-10-19T09:00:00"),
		);
		expect(nights).toHaveLength(1);
		expect(nights[0]?.label).toBe("Last night");
		expect(
			nights[0]?.started.map(({ title, paneId }) => [title, paneId]),
		).toEqual([
			["a", "pane-a"],
			["b", undefined],
		]);
		expect(nights[0]?.lines.map((l) => l.event)).toEqual([
			"Window closed",
			"Started b",
			"Started a",
		]);
	});
});
