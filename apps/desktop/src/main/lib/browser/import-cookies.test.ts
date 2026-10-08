import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash } from "node:crypto";
import {
	type CookieRow,
	cookieKey,
	decryptValue,
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
