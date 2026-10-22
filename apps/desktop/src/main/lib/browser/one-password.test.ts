import { describe, expect, test } from "bun:test";
import { OnePasswordSetupError, opError, siteMatches } from "./one-password";

describe("siteMatches", () => {
	test("matches the same host and its subdomains, not unrelated hosts", () => {
		expect(siteMatches("github.com", "https://github.com/login")).toBe(true);
		expect(siteMatches("github.com", "github.com")).toBe(true);
		expect(siteMatches("accounts.google.com", "google.com")).toBe(true);
		expect(siteMatches("notgithub.com", "github.com")).toBe(false);
		expect(siteMatches("github.com.evil.io", "github.com")).toBe(false);
	});
});

const failed = (stderr: string) =>
	Object.assign(new Error("Command failed: op item list"), { stderr });

describe("opError", () => {
	test("a missing op, or one not signed in, asks for the one-time setup", () => {
		const missing = Object.assign(new Error("spawn op ENOENT"), {
			code: "ENOENT",
		});
		expect(opError(missing)).toBeInstanceOf(OnePasswordSetupError);
		expect(opError(missing).message).toContain("Install the 1Password CLI");
		for (const stderr of [
			"[ERROR] You are not currently signed in. Please run `op signin --help` for instructions",
			"[ERROR] No accounts configured for use with 1Password CLI.",
			"[ERROR] error initializing client: connecting to desktop app: read: connection reset",
		]) {
			expect(opError(failed(stderr))).toBeInstanceOf(OnePasswordSetupError);
		}
	});

	test("a dismissed unlock is a plain retry, other failures pass through", () => {
		const dismissed = opError(
			failed("[ERROR] authorization prompt dismissed, please try again"),
		);
		expect(dismissed).not.toBeInstanceOf(OnePasswordSetupError);
		expect(dismissed.message).toContain("try the key again");
		const other = failed("[ERROR] rate limited");
		expect(opError(other)).toBe(other);
	});
});
