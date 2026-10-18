import { describe, expect, it } from "bun:test";
import type { BriefMessage } from "./brief";
import { catchUpOrder, catchUpSuggestion } from "./catch-up";

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

describe("catchUpOrder", () => {
	it("puts easy calls first and keeps ties in board order", () => {
		const kinds = {
			a: "yours",
			b: "done",
			c: "merge",
			d: "done",
			e: "duplicate",
		} as const;
		const order = catchUpOrder(Object.keys(kinds), (id) => ({
			kind: kinds[id as keyof typeof kinds],
			why: "",
			from: "",
		}));
		expect(order).toEqual(["b", "d", "e", "c", "a"]);
	});
});
