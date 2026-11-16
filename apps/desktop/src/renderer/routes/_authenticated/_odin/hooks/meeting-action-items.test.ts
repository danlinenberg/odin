import { describe, expect, it } from "bun:test";
import type { Meeting } from "../all/all-items";
import {
	actionItemsDue,
	actionItemsTask,
	seriesOf,
} from "./meeting-action-items";

const meeting = (id: string, end: string): Meeting => ({
	id,
	title: "Weekly sync",
	start: "2026-01-05T09:00:00.000Z",
	end,
	organizer: null,
	attendees: ["Alex"],
	location: null,
	joinUrl: null,
	description: null,
	recurring: true,
});

const NOW = Date.parse("2026-01-05T10:00:00.000Z");

describe("meeting action items", () => {
	it("keys a series by the uid, which can hold an @ itself", () => {
		expect(seriesOf("abc@example.com@2026-01-05T09:00:00.000Z")).toBe(
			"abc@example.com",
		);
	});

	it("waits for a marked meeting to end, then hands it over once", () => {
		const id = "abc@example.com@2026-01-05T09:30:00.000Z";
		const series = { "abc@example.com": "Weekly sync" };
		const early = actionItemsDue(
			[meeting(id, "2026-01-05T10:30:00.000Z")],
			series,
			{},
			NOW,
		);
		expect(early.ready).toEqual([]);
		expect(Object.keys(early.pending)).toEqual([id]);
		// The feed no longer lists it after it ends; pending still has it.
		const later = actionItemsDue(
			[],
			series,
			early.pending,
			Date.parse("2026-01-05T10:31:00.000Z"),
		);
		expect(later.ready.map((m) => m.title)).toEqual(["Weekly sync"]);
		expect(later.pending).toEqual({});
	});

	it("ignores unmarked meetings and drops pending ones when unmarked", () => {
		const id = "abc@example.com@2026-01-05T09:30:00.000Z";
		const pending = {
			[id]: { title: "x", end: "2026-01-05T09:45:00.000Z", attendees: [] },
		};
		const due = actionItemsDue(
			[meeting("other@2026-01-05T09:00:00.000Z", "2026-01-05T09:30:00.000Z")],
			{},
			pending,
			NOW,
		);
		expect(due).toEqual({ ready: [], pending: {} });
	});

	it("titles the task and notes who was there", () => {
		const text = actionItemsTask({
			title: "Weekly sync",
			end: "2026-01-05T09:30:00.000Z",
			attendees: ["Alex", "Riley Jones"],
		});
		expect(text.split("\n")[0]).toBe("Write action items: Weekly sync");
		expect(text).toContain("With: Alex, Riley Jones");
	});
});
