import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiKeyFallbackOn, planLimitedUntil } from "./api-key-fallback";
import { USE_API_KEY_IF_LIMITED } from "./session";

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

test("this computer's plan limit: its until, else 0", () => {
	expect(planLimitedUntil(() => '{"until": 1793160000.5}')).toBe(1793160000.5);
	expect(planLimitedUntil(() => "{}")).toBe(0);
	expect(
		planLimitedUntil(() => {
			throw new Error("ENOENT");
		}),
	).toBe(0);
});

test("a host session starts on the key while this computer's plan is out", () => {
	const home = mkdtempSync(join(tmpdir(), "odin-limit-"));
	mkdirSync(join(home, ".claude"));
	const run = (laptopUntil: number) =>
		spawnSync("python3", ["-c", USE_API_KEY_IF_LIMITED], {
			env: {
				HOME: home,
				ODIN_FALLBACK_API_KEY: "sk-ant-test-0123456789abcdefghij",
				ODIN_PLAN_LIMITED_UNTIL: String(laptopUntil),
			},
		}).status;
	expect(run(0)).toBe(1);
	const until = Date.now() / 1000 + 3600;
	expect(run(until)).toBe(0);
	// Kept on the host, for the sessions after this one.
	expect(run(0)).toBe(0);
	expect(
		JSON.parse(readFileSync(join(home, ".claude", "plan-limit.json"), "utf8"))
			.until,
	).toBe(until);
});
