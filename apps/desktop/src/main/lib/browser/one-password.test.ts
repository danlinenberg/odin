import { describe, expect, test } from "bun:test";
import { siteMatches } from "./one-password";

describe("siteMatches", () => {
	test("matches the same host and its subdomains, not unrelated hosts", () => {
		expect(siteMatches("github.com", "https://github.com/login")).toBe(true);
		expect(siteMatches("github.com", "github.com")).toBe(true);
		expect(siteMatches("accounts.google.com", "google.com")).toBe(true);
		expect(siteMatches("notgithub.com", "github.com")).toBe(false);
		expect(siteMatches("github.com.evil.io", "github.com")).toBe(false);
	});
});
