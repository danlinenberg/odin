import { describe, expect, it } from "bun:test";
import { probeError, retryWithFreshToken } from ".";

describe("probeError", () => {
	it("says a 401 is a sign-in, not a failure to retry", () => {
		expect(probeError(401)).toBe("signed out - sign in again");
	});

	it("leaves a rate limit as a status code - waiting fixes it, signing in doesn't", () => {
		expect(probeError(403)).toBe("HTTP 403");
	});

	it("keeps the status for everything else", () => {
		expect(probeError(500)).toBe("HTTP 500");
	});
});

describe("retryWithFreshToken", () => {
	const status = (code: number) => new Response("{}", { status: code });
	const never = async () => {
		throw new Error("should not refresh");
	};

	it("asks again with the stored token when another call already replaced it", async () => {
		const asked: string[] = [];
		const res = await retryWithFreshToken(
			status(401),
			"old",
			"new",
			never,
			async (t) => {
				asked.push(t);
				return status(200);
			},
		);
		expect(res.status).toBe(200);
		expect(asked).toEqual(["new"]);
	});

	it("refreshes once when the stored token is the one refused", async () => {
		const asked: string[] = [];
		const res = await retryWithFreshToken(
			status(401),
			"old",
			"old",
			async () => "fresh",
			async (t) => {
				asked.push(t);
				return status(200);
			},
		);
		expect(res.status).toBe(200);
		expect(asked).toEqual(["fresh"]);
	});

	it("keeps the 401 when the refresh fails, and leaves other answers alone", async () => {
		const ask = async () => status(200);
		expect(
			(
				await retryWithFreshToken(
					status(401),
					"old",
					"old",
					async () => null,
					ask,
				)
			).status,
		).toBe(401);
		expect(
			(await retryWithFreshToken(status(403), "old", "x", never, ask)).status,
		).toBe(403);
	});
});
