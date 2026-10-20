import { expect, test } from "bun:test";
import { apiKeyFallbackOn } from "./api-key-fallback";

const withHook = JSON.stringify({
	hooks: {
		StopFailure: [
			{
				matcher: "rate_limit",
				hooks: [
					{ command: "~/.claude/hooks/plan-limit.py 2>/dev/null || true" },
				],
			},
		],
	},
});

test("never set, the host follows claude-auto on this computer", () => {
	expect(apiKeyFallbackOn(undefined, withHook)).toBe(true);
	expect(apiKeyFallbackOn(undefined, "{}")).toBe(false);
	expect(apiKeyFallbackOn(undefined, "")).toBe(false);
});

test("the Settings switch wins", () => {
	expect(apiKeyFallbackOn(false, withHook)).toBe(false);
	expect(apiKeyFallbackOn(true, "")).toBe(true);
});
