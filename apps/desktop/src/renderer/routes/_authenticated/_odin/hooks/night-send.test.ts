import { describe, expect, test } from "bun:test";
import {
	ALERT_BEFORE_MS,
	hostPickedItem,
	missedLine,
	missedLogged,
	nextWindows,
	nightExclude,
	retryDelayMs,
	shouldAlert,
} from "./night-send";
import { nightWindow } from "./useNightAgentRunner";

describe("retrying a failed plan send", () => {
	test("waits a minute, then doubles, at most 15 minutes", () => {
		expect([1, 2, 3, 4, 5, 6, 20].map((n) => retryDelayMs(n) / 60_000)).toEqual(
			[1, 2, 4, 8, 15, 15, 15],
		);
	});
});

describe("the alert before the window", () => {
	const windowFrom = 1_000_000_000;
	const base = { windowFrom, hasPlan: false, alertedFor: null };

	test("not while the window is more than an hour away", () => {
		expect(
			shouldAlert({ ...base, now: windowFrom - ALERT_BEFORE_MS - 1 }),
		).toBe(false);
	});

	test("within the hour, or once it opened, when the host has no plan", () => {
		expect(shouldAlert({ ...base, now: windowFrom - ALERT_BEFORE_MS })).toBe(
			true,
		);
		expect(shouldAlert({ ...base, now: windowFrom + 60_000 })).toBe(true);
	});

	test("not when the host has tonight's plan, or this night was alerted", () => {
		expect(shouldAlert({ ...base, now: windowFrom, hasPlan: true })).toBe(
			false,
		);
		expect(
			shouldAlert({ ...base, now: windowFrom, alertedFor: windowFrom }),
		).toBe(false);
	});
});

describe("the missed-window line", () => {
	test("says the window and the last error", () => {
		expect(missedLine("23:00-07:00", "odin-prod", "SSO session expired")).toBe(
			"The 23:00-07:00 window opened on odin-prod with no plan for that night, so it started nothing when it opened. The last send failed: SSO session expired",
		);
	});

	test("is logged once per night, the host's and this computer's an hour apart counting as one", () => {
		const night = 1_000_000_000;
		const log = [
			{
				at: "2026-10-26T23:00:00.000Z",
				event: missedLine("23:00-07:00", "h", null),
				night,
			},
		];
		expect(missedLogged(log, night)).toBe(true);
		expect(missedLogged(log, night + 3_600_000)).toBe(true);
		expect(missedLogged(log, night + 86_400_000)).toBe(false);
		expect(missedLogged([{ ...log[0], event: "Sent" }], night)).toBe(false);
	});
});

describe("a plan for the next nights", () => {
	test("each night is set on its own day, so a clock change moves it by the hour", () => {
		const windowAt = (at: Date) => nightWindow(at, "22:00", "04:00");
		const now = new Date(2026, 9, 23, 12, 0);
		const nights = nextWindows(windowAt(now), 3, windowAt);
		expect(nights).toHaveLength(3);
		for (const night of nights) {
			const from = new Date(night.from * 1000);
			expect([from.getHours(), from.getMinutes()]).toEqual([22, 0]);
			expect(night.to - night.from).toBeGreaterThanOrEqual(5 * 3600);
		}
		expect(new Date(nights[2].from * 1000).getDate()).toBe(25);
	});

	test("excludes what is done here and what started on any host", () => {
		expect(
			nightExclude(
				["slack:C1:1.1", "jira:A-1"],
				[
					{
						at: "",
						event: "x",
						started: { key: "slack:C1:2.2", title: "t", source: "Slack" },
					},
					{ at: "", event: "y" },
					{
						at: "",
						event: "z",
						started: { key: "jira:A-1", title: "t", source: "Jira" },
					},
				],
			),
		).toEqual(["slack:C1:1.1", "jira:A-1", "slack:C1:2.2"]);
	});

	test("a Slack message the host picked becomes a row the board can attach to", () => {
		const item = hostPickedItem({
			key: "slack:D9:1.5",
			title: "Can you check",
			url: "https://x/p1",
			at: 100,
		});
		expect(item).toMatchObject({
			key: "slack:D9:1.5",
			source: "Slack",
			url: "https://x/p1",
			at: 100_000,
		});
		expect(item?.launch).toMatchObject({
			key: "D9:1.5",
			pageId: "D9:1.5",
			source: "reactions",
		});
		expect(
			hostPickedItem({ key: "jira:A-1", title: "t", url: "u", at: 1 }),
		).toBeNull();
		expect(
			hostPickedItem({ key: "slack:D9:1.5", title: "t", at: 1 }),
		).toBeNull();
	});
});
