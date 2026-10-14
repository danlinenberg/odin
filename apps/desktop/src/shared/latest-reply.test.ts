import { describe, expect, test } from "bun:test";
import {
	freshTldr,
	latestReply,
	sameReply,
	tldrPlacement,
} from "./latest-reply";

const at = "2026-10-14T10:00:00.000Z";
const brief = {
	last: "Opened PR #12.",
	urgency: "needs-you" as const,
	replyAt: at,
};

describe("latestReply", () => {
	test("is the agent's last turn, not yours", () => {
		const messages = [
			{ role: "assistant", text: "a" },
			{ role: "assistant", text: "b" },
			{ role: "user", text: "c" },
		];
		expect(latestReply(messages)?.text).toBe("b");
		expect(latestReply([{ role: "user", text: "c" }])).toBeUndefined();
	});
});

describe("sameReply", () => {
	test("matches the transcript's ISO time to the chat view's ms", () => {
		expect(sameReply(Date.parse(at), at)).toBe(true);
		expect(sameReply(at, at)).toBe(true);
		expect(sameReply(Date.parse(at) + 1, at)).toBe(false);
		expect(sameReply(undefined, at)).toBe(false);
		expect(sameReply(null, null)).toBe(false);
	});
});

describe("freshTldr", () => {
	test("shows the brief's TL;DR for the reply it read", () => {
		expect(freshTldr({ text: "short", at: Date.parse(at) }, brief)).toEqual({
			last: "Opened PR #12.",
			urgency: "needs-you",
			long: false,
		});
	});

	test("folds only a long reply", () => {
		const text = "x".repeat(601);
		expect(freshTldr({ text, at: Date.parse(at) }, brief)?.long).toBe(true);
	});

	test("hides a stale brief: a newer reply would get a wrong TL;DR", () => {
		const newer = Date.parse(at) + 60_000;
		expect(freshTldr({ text: "new", at: newer }, brief)).toBeNull();
		// A brief from before replyAt existed can't be placed either.
		expect(
			freshTldr({ text: "new", at: Date.parse(at) }, { last: "old" }),
		).toBeNull();
	});

	test("no LAST line, no card", () => {
		expect(
			freshTldr({ text: "x", at: Date.parse(at) }, { ...brief, last: null }),
		).toBeNull();
	});
});

describe("tldrPlacement", () => {
	const tldr = { last: "x", urgency: "fyi" as const, long: true };
	test("a reply with action items gets one box: the TL;DR leads that card", () => {
		expect(tldrPlacement(tldr, true)).toBe("action-items");
	});
	test("any other reply gets its own TL;DR card", () => {
		expect(tldrPlacement(tldr, false)).toBe("card");
	});
	test("no fresh TL;DR, nothing to place", () => {
		expect(tldrPlacement(null, true)).toBeNull();
		expect(tldrPlacement(null, false)).toBeNull();
	});
});
