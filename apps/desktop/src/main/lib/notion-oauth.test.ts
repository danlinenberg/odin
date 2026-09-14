import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readOdinConfig,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";
import {
	completeNotionOAuth,
	isNotionOAuthCallback,
	isNotionOAuthConfigured,
	readNotionOAuthResult,
	startNotionOAuth,
} from "./notion-oauth";

const dir = mkdtempSync(join(tmpdir(), "notion-oauth-"));
process.env.ODIN_CONFIG_PATH = join(dir, "odin.json");

const originalFetch = globalThis.fetch;

beforeEach(() => {
	updateOdinConfig({
		notionClientId: "cid",
		notionClientSecret: "csecret",
		notionRedirectUrl: "https://example.test/notion.html",
		notionToken: undefined,
		notionRefreshToken: undefined,
	});
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockTokenEndpoint(body: unknown) {
	const calls: { url: string; auth: string; body: unknown }[] = [];
	globalThis.fetch = mock(async (url: string, init: RequestInit) => {
		const headers = init.headers as Record<string, string>;
		calls.push({
			url: String(url),
			auth: headers.Authorization,
			body: JSON.parse(String(init.body)),
		});
		return new Response(JSON.stringify(body));
	}) as unknown as typeof fetch;
	return calls;
}

describe("isNotionOAuthCallback", () => {
	test("matches only the Notion callback", () => {
		expect(isNotionOAuthCallback("odin://oauth/notion?code=x")).toBe(true);
		// Must not swallow the Slack callback or the sign-in link.
		expect(isNotionOAuthCallback("odin://oauth/slack?code=x")).toBe(false);
		expect(isNotionOAuthCallback("odin://auth?token=x")).toBe(false);
	});
});

describe("startNotionOAuth", () => {
	test("opens the page picker with our state", async () => {
		const { state, authorizeUrl } = await startNotionOAuth(async () => {});
		const url = new URL(authorizeUrl);
		expect(url.origin + url.pathname).toBe(
			"https://api.notion.com/v1/oauth/authorize",
		);
		expect(url.searchParams.get("state")).toBe(state);
		expect(url.searchParams.get("response_type")).toBe("code");
		// "user" keeps the grant personal rather than installing to a workspace.
		expect(url.searchParams.get("owner")).toBe("user");
	});

	test("refuses to start unconfigured", async () => {
		updateOdinConfig({
			notionClientId: undefined,
			notionClientSecret: undefined,
			notionRedirectUrl: undefined,
		});
		expect(isNotionOAuthConfigured()).toBe(false);
		await expect(startNotionOAuth()).rejects.toThrow("not configured");
	});
});

describe("completeNotionOAuth", () => {
	test("stores both tokens and authenticates with Basic auth", async () => {
		const { state } = await startNotionOAuth(async () => {});
		const calls = mockTokenEndpoint({
			access_token: "ntn_access",
			refresh_token: "ntn_refresh",
			workspace_name: "Dan's Notion",
		});
		await completeNotionOAuth(`odin://oauth/notion?code=abc&state=${state}`);
		expect(calls[0].url).toBe("https://api.notion.com/v1/oauth/token");
		// Notion's token endpoint wants client_id:client_secret as Basic auth.
		expect(calls[0].auth).toBe(
			`Basic ${Buffer.from("cid:csecret").toString("base64")}`,
		);
		expect(calls[0].body).toMatchObject({
			grant_type: "authorization_code",
			code: "abc",
			redirect_uri: "https://example.test/notion.html",
		});
		const cfg = readOdinConfig();
		expect(cfg.notionToken).toBe("ntn_access");
		expect(cfg.notionRefreshToken).toBe("ntn_refresh");
		expect(readNotionOAuthResult(state)).toMatchObject({
			status: "connected",
			identity: "Dan's Notion",
		});
	});

	test("ignores a callback whose state we never issued", async () => {
		const calls = mockTokenEndpoint({ access_token: "nope" });
		await completeNotionOAuth("odin://oauth/notion?code=x&state=not-ours");
		expect(calls).toHaveLength(0);
		expect(readOdinConfig().notionToken).toBeUndefined();
	});

	test("a rejected exchange leaves any existing token alone", async () => {
		updateOdinConfig({ notionToken: "ntn_existing" });
		const { state } = await startNotionOAuth(async () => {});
		mockTokenEndpoint({ error: "invalid_grant" });
		await completeNotionOAuth(`odin://oauth/notion?code=stale&state=${state}`);
		expect(readOdinConfig().notionToken).toBe("ntn_existing");
		expect(readNotionOAuthResult(state)?.status).toBe("failed");
	});
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
