import { describe, expect, test } from "bun:test";
import { compactedAtAfter, stopStatus } from "./useAgentHookListener";

describe("stopStatus", () => {
	test("a turn that ended while you were elsewhere is Done", () => {
		expect(stopStatus("working", false)).toBe("review");
	});

	test("a turn you watched end is not news", () => {
		expect(stopStatus("working", true)).toBe("idle");
	});

	test("answering a prompt already engaged you - no Done card for it", () => {
		expect(stopStatus("permission", false)).toBe("idle");
	});
});

describe("compactedAtAfter", () => {
	test("PreCompact marks the conversation compacted", () => {
		expect(compactedAtAfter("Compacting", undefined, 5)).toBe(5);
		expect(compactedAtAfter("Compacting", 2, 5)).toBe(5);
	});

	test("a Start - a prompt or a tool call - drops the mark", () => {
		expect(compactedAtAfter("Start", 2, 5)).toBeUndefined();
	});

	test("every other event leaves it alone", () => {
		for (const eventType of [
			"Stop",
			"PermissionRequest",
			"PendingQuestion",
			"Failed",
		] as const) {
			expect(compactedAtAfter(eventType, 2, 5)).toBe(2);
			expect(compactedAtAfter(eventType, undefined, 5)).toBeUndefined();
		}
	});
});
