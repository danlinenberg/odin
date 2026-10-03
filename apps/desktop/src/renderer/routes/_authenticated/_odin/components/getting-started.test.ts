import { expect, test } from "bun:test";
import { isFreshProfile, satisfiedSteps } from "./getting-started";

const empty = {
	connections: [],
	todoCount: 0,
	sessionCount: 0,
	ownAutomationCount: 0,
	onReview: false,
};

test("only an unused profile is fresh", () => {
	expect(isFreshProfile([], 0)).toBe(true);
	expect(isFreshProfile([{ configured: false, error: null }], 0)).toBe(true);
	expect(isFreshProfile([], 1)).toBe(false);
	// A failing sign-in is still someone who has been here.
	expect(isFreshProfile([{ configured: true, error: "HTTP 500" }], 0)).toBe(
		false,
	);
});

test("each step ticks off its own signal, in checklist order", () => {
	expect(satisfiedSteps(empty)).toEqual([]);
	expect(
		satisfiedSteps({
			connections: [{ configured: true, error: null }],
			todoCount: 1,
			sessionCount: 1,
			ownAutomationCount: 1,
			onReview: true,
		}),
	).toEqual(["connections", "task", "session", "automation", "review"]);
});

test("a broken sign-in doesn't count as connected", () => {
	expect(
		satisfiedSteps({
			...empty,
			connections: [{ configured: true, error: "signed out — sign in again" }],
		}),
	).toEqual([]);
});
