import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readOdinConfig,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";
import {
	airtableAccessToken,
	completeAirtableOAuth,
	isAirtableOAuthCallback,
	pkcePair,
	readAirtableOAuthResult,
	startAirtableOAuth,
} from "./airtable-oauth";

const dir = mkdtempSync(join(tmpdir(), "airtable-oauth-"));
process.env.ODIN_CONFIG_PATH = join(dir, "odin.json");
const originalFetch = globalThis.fetch;

beforeEach(() => {
	updateOdinConfig({
		airtableClientId: "cid",
		airtableClientSecret: "csecret",
		airtableRedirectUrl: "https://example.test/airtable.html",
		airtableAccessToken: undefined,
		airtableRefreshToken: undefined,
		airtableTokenExpiresAt: undefined,
	});
});
afterEach(() => {
	globalThis.fetch = originalFetch;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Airtable's token endpoint, then whoami for the identity. */
function mockAirtable(token: unknown) {
	const calls: { url: string; body: URLSearchParams | null; auth: string }[] =
		[];
	globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
		calls.push({
			url: String(url),
			body: init?.body ? new URLSearchParams(String(init.body)) : null,
			auth: String(
				(init?.headers as Record<string, string> | undefined)?.Authorization,
			),
		});
		if (String(url).includes("/meta/whoami"))
			return new Response(JSON.stringify({ email: "alex@example.com" }));
		return new Response(JSON.stringify(token));
	}) as unknown as typeof fetch;
	return calls;
}

test("pkcePair's challenge is the verifier's SHA-256, base64url", () => {
	const { verifier, challenge } = pkcePair();
	expect(challenge).toBe(
		createHash("sha256").update(verifier).digest("base64url"),
	);
	expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
});

test("matches only the Airtable callback", () => {
	expect(isAirtableOAuthCallback("odin://oauth/airtable?code=x")).toBe(true);
	expect(isAirtableOAuthCallback("odin://oauth/calendar?code=x")).toBe(false);
});

test("sign-in sends PKCE, exchanges the code with its verifier, and stores the tokens", async () => {
	let opened = "";
	const { state } = await startAirtableOAuth(async (url) => {
		opened = url;
	});
	const authorize = new URL(opened);
	expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
	const challenge = authorize.searchParams.get("code_challenge");

	const calls = mockAirtable({
		access_token: "at1",
		refresh_token: "rt1",
		expires_in: 3600,
	});
	await completeAirtableOAuth(`odin://oauth/airtable?code=abc&state=${state}`);

	const exchange = calls[0];
	expect(exchange.url).toBe("https://airtable.com/oauth2/v1/token");
	expect(exchange.auth).toBe(
		`Basic ${Buffer.from("cid:csecret").toString("base64")}`,
	);
	const verifier = exchange.body?.get("code_verifier") ?? "";
	expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
		challenge ?? "",
	);
	expect(readOdinConfig().airtableRefreshToken).toBe("rt1");
	expect(readAirtableOAuthResult(state)).toMatchObject({
		status: "connected",
		identity: "alex@example.com",
	});
});

test("a spent access token is refreshed and the rotated refresh token kept", async () => {
	updateOdinConfig({
		airtableAccessToken: "old",
		airtableRefreshToken: "rt1",
		airtableTokenExpiresAt: Date.now() - 1,
	});
	const calls = mockAirtable({
		access_token: "at2",
		refresh_token: "rt2",
		expires_in: 3600,
	});
	expect(await airtableAccessToken()).toBe("at2");
	expect(calls[0].body?.get("refresh_token")).toBe("rt1");
	expect(readOdinConfig().airtableRefreshToken).toBe("rt2");
});
