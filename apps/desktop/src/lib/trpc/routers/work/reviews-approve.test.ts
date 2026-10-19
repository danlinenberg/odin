import { describe, expect, test } from "bun:test";
import { reviewsApprove } from "./index";

describe("reviewsApprove", () => {
	const review = (login: string, state: string) => ({ user: { login }, state });

	test("someone's latest review approves and nobody's latest asks for changes", () => {
		expect(
			reviewsApprove([review("a", "APPROVED"), review("b", "COMMENTED")]),
		).toBe(true);
		expect(
			reviewsApprove([
				review("a", "APPROVED"),
				review("b", "CHANGES_REQUESTED"),
			]),
		).toBe(false);
		expect(
			reviewsApprove([
				review("b", "CHANGES_REQUESTED"),
				review("b", "APPROVED"),
			]),
		).toBe(true);
		expect(reviewsApprove([review("a", "COMMENTED")])).toBe(false);
	});
});
