import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	activePlanLimit,
	apiKeyFallbackOn,
	planLimitedUntil,
} from "./api-key-fallback";
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

test("the plan-limit note shows while its until is ahead", () => {
	const note = JSON.stringify({
		until: 2000,
		reason: "You've hit your weekly limit · resets 6am ",
		at: 900,
	});
	expect(activePlanLimit(1000, () => note)).toEqual({
		until: 2000,
		reason: "You've hit your weekly limit · resets 6am",
	});
	expect(activePlanLimit(1000, () => '{"until": 2000}')).toEqual({
		until: 2000,
		reason: "",
	});
});

test("the plan-limit note is gone once it lapsed, missing or unreadable", () => {
	expect(activePlanLimit(2000, () => '{"until": 2000}')).toBeNull();
	expect(activePlanLimit(3000, () => '{"until": 2000}')).toBeNull();
	expect(
		activePlanLimit(1000, () => {
			throw new Error("ENOENT");
		}),
	).toBeNull();
	expect(activePlanLimit(1000, () => '{"until": 20')).toBeNull();
	expect(activePlanLimit(1000, () => '{"until": "soon"}')).toBeNull();
	expect(activePlanLimit(1000, () => "null")).toBeNull();
});

// Three python3 starts in a row: past bun's 5s default on a busy CI Mac.
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
}, 30_000);
