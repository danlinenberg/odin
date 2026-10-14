import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type CookieRow,
	cookieDomains,
	cookieKey,
	decryptValue,
	isConnectionCookie,
	newestCookieDb,
	toCookie,
} from "./import-cookies";

const key = cookieKey("keychain-secret");

const encrypt = (plain: Buffer) => {
	const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
	return Buffer.concat([
		Buffer.from("v10"),
		cipher.update(plain),
		cipher.final(),
	]);
};

const row: CookieRow = {
	host_key: ".github.com",
	name: "user_session",
	value: "",
	encrypted_value: Buffer.alloc(0),
	path: "/",
	expires_utc: (1_900_000_000 + 11_644_473_600) * 1e6,
	has_expires: 1,
	is_secure: 1,
	is_httponly: 1,
	samesite: 1,
};

describe("decryptValue", () => {
	test("decrypts v10 values, dropping the host hash from DB version 24", () => {
		const hash = createHash("sha256").update(".github.com").digest();
		const newer = encrypt(Buffer.concat([hash, Buffer.from("abc")]));
		const older = encrypt(Buffer.from("abc"));
		expect(decryptValue({ value: "", encrypted_value: newer }, key, 24)).toBe(
			"abc",
		);
		expect(decryptValue({ value: "", encrypted_value: older }, key, 23)).toBe(
			"abc",
		);
		expect(
			decryptValue(
				{ value: "plain", encrypted_value: Buffer.alloc(0) },
				key,
				24,
			),
		).toBe("plain");
	});

	test("a row with no encrypted value is empty, not an error", () => {
		expect(decryptValue({ value: "", encrypted_value: null }, key, 24)).toBe(
			"",
		);
	});
});

describe("toCookie", () => {
	test("maps a Chromium row to Electron's cookie shape", () => {
		expect(toCookie(row, "abc")).toEqual({
			url: "https://github.com/",
			name: "user_session",
			value: "abc",
			domain: ".github.com",
			path: "/",
			secure: true,
			httpOnly: true,
			expirationDate: 1_900_000_000,
			sameSite: "lax",
		});
		const hostOnly = toCookie(
			{ ...row, host_key: "github.com", has_expires: 0, samesite: -1 },
			"x",
		);
		expect(hostOnly.domain).toBeUndefined();
		expect(hostOnly.expirationDate).toBeUndefined();
		expect(hostOnly.sameSite).toBe("unspecified");
	});
});

test("newestCookieDb skips a browser macOS won't let Odin read", () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "odin-home-"));
	const support = path.join(home, "Library/Application Support");
	const arc = path.join(support, "Arc/User Data/Profile 1");
	mkdirSync(arc, { recursive: true });
	writeFileSync(path.join(arc, "Cookies"), "");
	const chrome = path.join(support, "Google/Chrome");
	mkdirSync(chrome, { recursive: true });
	chmodSync(chrome, 0);
	try {
		expect(newestCookieDb(home)?.browser.name).toBe("Arc");
	} finally {
		chmodSync(chrome, 0o755);
	}
});

describe("cookieDomains", () => {
	test("keeps only the connected sites, and Google only with Gmail", () => {
		const all = ["slack", "jira", "github", "notion", "clickup"] as const;
		const withGmail = cookieDomains([...all, "gmail"]);
		const without = cookieDomains([...all]);
		for (const host of [
			".slack.com",
			"imagen.atlassian.net",
			".id.atlassian.com",
			"github.com",
			"www.notion.so",
			"app.clickup.com",
		])
			expect(isConnectionCookie(host, without)).toBe(true);
		for (const host of [
			".google.com",
			"accounts.google.com",
			".chase.com",
			"notslack.com",
			"slack.com.evil.io",
		])
			expect(isConnectionCookie(host, without)).toBe(false);
		expect(isConnectionCookie(".google.com", withGmail)).toBe(true);
		expect(isConnectionCookie("mail.google.com", withGmail)).toBe(true);
		const slackOnly = cookieDomains(["slack"]);
		expect(isConnectionCookie(".slack.com", slackOnly)).toBe(true);
		expect(isConnectionCookie("github.com", slackOnly)).toBe(false);
		expect(isConnectionCookie("www.notion.so", slackOnly)).toBe(false);
	});
});
