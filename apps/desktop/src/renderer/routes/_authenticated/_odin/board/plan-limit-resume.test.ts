import { describe, expect, it } from "bun:test";
import { planLimitResumeKey } from "./plan-limit-resume";

const limit = {
	role: "assistant",
	text: "You've hit your individual spend limit · run /usage-credits to raise it",
};

describe("planLimitResumeKey", () => {
	it("restarts a session stopped on the plan's limit while the key is on", () => {
		expect(planLimitResumeKey("p1", limit, 2000, 1000)).toBe("p1:2000");
	});
	it("leaves it when claude-auto hasn't switched to the key", () => {
		expect(planLimitResumeKey("p1", limit, 0, 1000)).toBeNull();
		expect(planLimitResumeKey("p1", limit, 900, 1000)).toBeNull();
	});
	it("leaves a turn that failed on anything else", () => {
		const other = { role: "assistant", text: "API Error: 500 Internal error" };
		expect(planLimitResumeKey("p1", other, 2000, 1000)).toBeNull();
		expect(planLimitResumeKey("p1", undefined, 2000, 1000)).toBeNull();
		expect(
			planLimitResumeKey("p1", { ...limit, role: "user" }, 2000, 1000),
		).toBeNull();
	});
});
