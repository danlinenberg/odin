import { describe, expect, it } from "bun:test";
import { feedError } from ".";

describe("feedError", () => {
	it("treats 401 as a dead credential", () => {
		const error = feedError("GitHub", 401, '{"message":"Bad credentials"}');
		expect(error.code).toBe("UNAUTHORIZED");
		expect(error.message).toContain("Settings → Connections");
	});

	it("treats a 403 rate limit as a plain failure", () => {
		expect(feedError("GitHub", 403, "API rate limit exceeded").code).toBe(
			"BAD_REQUEST",
		);
	});

	it("treats other 403s as a dead credential", () => {
		expect(feedError("Jira", 403, "Forbidden").code).toBe("UNAUTHORIZED");
	});

	it("keeps the API body for everything else", () => {
		expect(feedError("Jira", 500, "kaboom").message).toContain("kaboom");
	});
});
