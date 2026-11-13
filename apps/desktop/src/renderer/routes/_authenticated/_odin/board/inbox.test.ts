import { describe, expect, test } from "bun:test";
import {
	itemEffort,
	QUEUED_STUCK_MS,
	SILENT_STUCK_MS,
	stuckReason,
} from "./inbox";

const item = (text: string, fences: string[] = []) => ({ text, fences });

describe("itemEffort", () => {
	test("a choice, an approval, a merge or a ! command is one click", () => {
		expect(itemEffort(item("Pick the format [CSV | Page]"))).toBe("quick");
		expect(itemEffort(item("Approve the rollout"))).toBe("quick");
		expect(
			itemEffort(item("Merge PR #12 https://github.com/acme/app/pull/12")),
		).toBe("quick");
		expect(
			itemEffort(
				item("Delete the old folders:", ["```\n! rm -rf /tmp/old\n```"]),
			),
		).toBe("quick");
	});

	test("a move, a (you only) chore or an open question needs thinking", () => {
		expect(
			itemEffort(item("Move this session to my computer - app sign-in")),
		).toBe("think");
		expect(itemEffort(item("Rotate the key in the console (you only)"))).toBe(
			"think",
		);
		expect(itemEffort(item("Decide where plugins live"))).toBe("think");
	});

	test("anything else is a look", () => {
		expect(
			itemEffort(item("Review PR #9 https://github.com/acme/app/pull/9")),
		).toBe("look");
		expect(itemEffort(item("Read the draft reply above"))).toBe("look");
	});
});

describe("stuckReason", () => {
	const now = 10 * 60 * 60_000;
	test("nothing wrong is not stuck", () => {
		expect(stuckReason({}, now)).toBeNull();
		expect(
			stuckReason({ working: { lastMessageAt: now - 60_000 } }, now),
		).toBeNull();
		expect(
			stuckReason(
				{ queued: { reason: "5 working", since: now - 60_000 } },
				now,
			),
		).toBeNull();
	});

	test("each signal names its fix", () => {
		expect(stuckReason({ ciGaveUp: true }, now)?.fix).toBe("open");
		expect(stuckReason({ diedMidTurn: true }, now)?.fix).toBe("resume");
		expect(stuckReason({ conflicts: "PR #3" }, now)?.fix).toBe("rebase");
		expect(
			stuckReason(
				{ queued: { reason: "5 working", since: now - QUEUED_STUCK_MS } },
				now,
			),
		).toEqual({ why: "Queued 30 min - 5 working", fix: "resume" });
		expect(
			stuckReason(
				{ working: { lastMessageAt: now - SILENT_STUCK_MS - 7 * 60_000 } },
				now,
			),
		).toEqual({ why: "No new output for 52 min", fix: "status" });
	});
});
