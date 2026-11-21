import { describe, expect, it } from "bun:test";
import type { BriefMessage } from "./brief";
import { catchUpSuggestion } from "./catch-up";

const reply = (text: string): BriefMessage[] => [
	{ role: "user", text: "do it", at: null },
	{ role: "assistant", text, at: null },
];

describe("catchUpSuggestion", () => {
	it("takes the sweep's call first", () => {
		const s = catchUpSuggestion({
			sweptDrop: "Thread answered",
			duplicateOf: "Other",
		});
		expect(s).toMatchObject({ kind: "done", why: "Thread answered" });
	});

	it("takes the session's own DROPPED line", () => {
		expect(
			catchUpSuggestion({ selfDropped: "Fixed by Ayelet", duplicateOf: "X" }),
		).toMatchObject({ kind: "done", why: "Fixed by Ayelet", from: "Session" });
	});

	it("names the other card on a duplicate", () => {
		expect(catchUpSuggestion({ duplicateOf: "Fix HDR" })).toMatchObject({
			kind: "duplicate",
			why: "Same ask as “Fix HDR”.",
		});
	});

	it("offers the merge with its PR", () => {
		const s = catchUpSuggestion({
			messages: reply(
				"Opened https://github.com/o/r/pull/12\n\nACTION ITEMS\n1. Merge #12",
			),
		});
		expect(s).toMatchObject({
			kind: "merge",
			url: "https://github.com/o/r/pull/12",
		});
	});

	it("calls an empty ACTION ITEMS done", () => {
		expect(
			catchUpSuggestion({ messages: reply("Shipped.\n\nACTION ITEMS: none") })
				.kind,
		).toBe("done");
	});

	it("shows the first item when it is yours", () => {
		const s = catchUpSuggestion({
			messages: reply("ACTION ITEMS\n1. Pick a format [A | B]\n2. Merge #3"),
		});
		expect(s).toMatchObject({
			kind: "yours",
			why: "Pick a format [A | B]",
			from: "Action item 1 of 2",
		});
	});

	it("keeps an unread card yours", () => {
		expect(catchUpSuggestion({}).kind).toBe("yours");
	});
});
