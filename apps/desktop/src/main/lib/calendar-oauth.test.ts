import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readOdinConfig,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";
import {
	completeCalendarOAuth,
	isCalendarOAuthCallback,
	isCalendarOAuthConfigured,
	readCalendarOAuthResult,
	startCalendarOAuth,
} from "./calendar-oauth";
import { calendarAccessToken } from "./calendar-token";

const dir = mkdtempSync(join(tmpdir(), "calendar-oauth-"));
process.env.ODIN_CONFIG_PATH = join(dir, "odin.json");

const originalFetch = globalThis.fetch;

beforeEach(() => {
	updateOdinConfig({
		calendarClientId: "cid",
		calendarClientSecret: "csecret",
		calendarRedirectUrl: "https://example.test/calendar.html",
		calendarUrl: undefined,
		calendarAccessToken: undefined,
		calendarRefreshToken: undefined,
		calendarTokenExpiresAt: undefined,
	});
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

/** Google's token endpoint, then `calendars/primary` for the identity. */
function mockGoogle(token: unknown) {
	const calls: { url: string; body: URLSearchParams | null }[] = [];
	globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
		const body = init?.body ? new URLSearchParams(String(init.body)) : null;
		calls.push({ url: String(url), body });
		if (String(url).includes("/calendars/primary")) {
			return new Response(JSON.stringify({ id: "dan@example.com" }));
		}
		return new Response(JSON.stringify(token));
	}) as unknown as typeof fetch;
	return calls;
}

describe("isCalendarOAuthCallback", () => {
	test("matches only the calendar callback", () => {
		expect(isCalendarOAuthCallback("odin://oauth/calendar?code=x")).toBe(true);
		expect(isCalendarOAuthCallback("odin://oauth/notion?code=x")).toBe(false);
		expect(isCalendarOAuthCallback("odin://auth?token=x")).toBe(false);
	});
});

describe("startCalendarOAuth", () => {
	test("asks for read-only calendar access and a refresh token", async () => {
		const { state, authorizeUrl } = await startCalendarOAuth(async () => {});
		const url = new URL(authorizeUrl);
		expect(url.origin + url.pathname).toBe(
			"https://accounts.google.com/o/oauth2/v2/auth",
		);
		expect(url.searchParams.get("state")).toBe(state);
		expect(url.searchParams.get("scope")).toBe(
			"https://www.googleapis.com/auth/calendar.readonly",
		);
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(url.searchParams.get("redirect_uri")).toBe(
			"https://example.test/calendar.html",
		);
	});

	test("refuses to start unconfigured", async () => {
		updateOdinConfig({
			calendarClientId: undefined,
			calendarClientSecret: undefined,
			calendarRedirectUrl: undefined,
		});
		expect(isCalendarOAuthConfigured()).toBe(false);
		await expect(startCalendarOAuth()).rejects.toThrow("not configured");
	});
});

describe("completeCalendarOAuth", () => {
	test("stores the tokens, drops a pasted address and names the account", async () => {
		updateOdinConfig({ calendarUrl: "https://example.test/basic.ics" });
		const { state } = await startCalendarOAuth(async () => {});
		const calls = mockGoogle({
			access_token: "ya29.access",
			refresh_token: "1//refresh",
			expires_in: 3599,
		});
		await completeCalendarOAuth(
			`odin://oauth/calendar?code=abc&state=${state}`,
		);
		expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
		expect(Object.fromEntries(calls[0].body ?? [])).toMatchObject({
			grant_type: "authorization_code",
			code: "abc",
			client_id: "cid",
			client_secret: "csecret",
			redirect_uri: "https://example.test/calendar.html",
		});
		const cfg = readOdinConfig();
		expect(cfg.calendarAccessToken).toBe("ya29.access");
		expect(cfg.calendarRefreshToken).toBe("1//refresh");
		expect(cfg.calendarTokenExpiresAt).toBeGreaterThan(Date.now());
		expect(cfg.calendarUrl).toBeUndefined();
		expect(readCalendarOAuthResult(state)).toMatchObject({
			status: "connected",
			identity: "dan@example.com",
		});
	});

	test("no refresh token is a failure, not an hour-long connection", async () => {
		const { state } = await startCalendarOAuth(async () => {});
		mockGoogle({ access_token: "ya29.access", expires_in: 3599 });
		await completeCalendarOAuth(
			`odin://oauth/calendar?code=abc&state=${state}`,
		);
		expect(readOdinConfig().calendarRefreshToken).toBeUndefined();
		expect(readCalendarOAuthResult(state)?.status).toBe("failed");
	});

	test("ignores a callback whose state we never issued", async () => {
		const calls = mockGoogle({ access_token: "nope", refresh_token: "nope" });
		await completeCalendarOAuth("odin://oauth/calendar?code=x&state=not-ours");
		expect(calls).toHaveLength(0);
		expect(readOdinConfig().calendarAccessToken).toBeUndefined();
	});
});

describe("calendarAccessToken", () => {
	test("refreshes an expired token and keeps the refresh token", async () => {
		updateOdinConfig({
			calendarAccessToken: "old",
			calendarRefreshToken: "1//refresh",
			calendarTokenExpiresAt: Date.now() - 1000,
		});
		const calls = mockGoogle({ access_token: "new", expires_in: 3599 });
		expect(await calendarAccessToken()).toBe("new");
		expect(calls[0].body?.get("grant_type")).toBe("refresh_token");
		expect(readOdinConfig().calendarRefreshToken).toBe("1//refresh");
	});

	test("spends no request while the token is fresh", async () => {
		updateOdinConfig({
			calendarAccessToken: "fresh",
			calendarRefreshToken: "1//refresh",
			calendarTokenExpiresAt: Date.now() + 30 * 60_000,
		});
		const calls = mockGoogle({});
		expect(await calendarAccessToken()).toBe("fresh");
		expect(calls).toHaveLength(0);
	});
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
