import { describe, expect, test } from "bun:test";
import { answered, siteMatch } from "./one-password";

describe("siteMatch", () => {
	test("the same host and its subdomains match best", () => {
		expect(siteMatch("github.com", "https://github.com/login")).toBe(2);
		expect(siteMatch("github.com", "github.com")).toBe(2);
		expect(siteMatch("accounts.google.com", "google.com")).toBe(2);
	});

	test("another host on the same site still matches", () => {
		expect(siteMatch("auth.getdbt.com", "https://cloud.getdbt.com")).toBe(1);
		expect(siteMatch("login.example.co.uk", "www.example.co.uk")).toBe(1);
	});

	test("other sites never match", () => {
		expect(siteMatch("notgithub.com", "github.com")).toBe(0);
		expect(siteMatch("github.com.evil.io", "github.com")).toBe(0);
		expect(siteMatch("a.co.uk", "b.co.uk")).toBe(0);
		expect(siteMatch("evil.github.io", "me.github.io")).toBe(0);
		expect(siteMatch("github.com", "not a url")).toBe(0);
	});
});

describe("answered", () => {
	test("a 1Password call that never answers fails with what to do", async () => {
		await expect(answered("Imagen", new Promise(() => {}), 10)).rejects.toThrow(
			/unlock it and approve Odin/,
		);
	});

	test("an answer in time comes through", async () => {
		expect(await answered("Imagen", Promise.resolve(3), 1000)).toBe(3);
	});
});
