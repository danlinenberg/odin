import { describe, expect, test } from "bun:test";
import { stopStatus } from "./useAgentHookListener";

describe("stopStatus", () => {
	test("a turn that ended while you were elsewhere is Done", () => {
		expect(stopStatus("working", false)).toBe("review");
	});

	test("a turn you watched end is not news", () => {
		expect(stopStatus("working", true)).toBe("idle");
	});

	test("answering a prompt already engaged you — no Done card for it", () => {
		expect(stopStatus("permission", false)).toBe("idle");
	});
});
