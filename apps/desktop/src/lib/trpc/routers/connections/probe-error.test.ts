import { describe, expect, it } from "bun:test";
import { probeError } from ".";

describe("probeError", () => {
	it("says a 401 is a sign-in, not a failure to retry", () => {
		expect(probeError(401)).toBe("signed out — sign in again");
	});

	it("leaves a rate limit as a status code — waiting fixes it, signing in doesn't", () => {
		expect(probeError(403)).toBe("HTTP 403");
	});

	it("keeps the status for everything else", () => {
		expect(probeError(500)).toBe("HTTP 500");
	});
});
