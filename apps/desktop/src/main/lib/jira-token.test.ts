import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readOdinConfig,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";
import { hasJiraOAuth, jiraRequestContext } from "./jira-token";

const dir = mkdtempSync(join(tmpdir(), "jira-token-"));
process.env.ODIN_CONFIG_PATH = join(dir, "odin.json");

const originalFetch = globalThis.fetch;

beforeEach(() => {
	updateOdinConfig({
		jiraClientId: "cid",
		jiraClientSecret: "csecret",
		jiraRedirectUrl: "https://example.test/jira.html",
		jiraAccessToken: undefined,
		jiraRefreshToken: undefined,
		jiraTokenExpiresAt: undefined,
		jiraCloudId: undefined,
		jiraSiteUrl: undefined,
	});
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
	const calls: string[] = [];
	globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
		calls.push(String(url));
		return new Response(JSON.stringify(handler(String(url), init)));
	}) as unknown as typeof fetch;
	return calls;
}

describe("hasJiraOAuth", () => {
	test("needs a refresh token, not just an app", () => {
		expect(hasJiraOAuth()).toBe(false);
		updateOdinConfig({ jiraRefreshToken: "r1" });
		expect(hasJiraOAuth()).toBe(true);
	});
});

describe("jiraRequestContext", () => {
	test("null when Jira isn't signed in — there is no other way in", async () => {
		expect(await jiraRequestContext()).toBeNull();
	});

	test("OAuth routes through the gateway, and links stay on the site", async () => {
		updateOdinConfig({
			jiraAccessToken: "at-live",
			jiraRefreshToken: "r1",
			jiraTokenExpiresAt: Date.now() + 3_600_000,
		});
		mockFetch(() => [
			{ id: "cloud-123", url: "https://real-site.atlassian.net" },
		]);
		const ctx = await jiraRequestContext();
		// The cloudId path, never the site host — that's what 3LO requires.
		expect(ctx?.base).toBe("https://api.atlassian.com/ex/jira/cloud-123");
		expect(ctx?.authorization).toBe("Bearer at-live");
		expect(ctx?.siteUrl).toBe("https://real-site.atlassian.net");
		// Resolved once, then cached.
		expect(readOdinConfig().jiraCloudId).toBe("cloud-123");
	});

	test("an expired access token is refreshed, and the refresh token rotates", async () => {
		updateOdinConfig({
			jiraAccessToken: "at-stale",
			jiraRefreshToken: "r-old",
			jiraTokenExpiresAt: Date.now() - 1_000,
			jiraCloudId: "cloud-123",
			jiraSiteUrl: "https://real-site.atlassian.net",
		});
		const calls = mockFetch((url) =>
			url.includes("/oauth/token")
				? {
						access_token: "at-new",
						refresh_token: "r-new",
						expires_in: 3600,
					}
				: [],
		);
		const ctx = await jiraRequestContext();
		expect(calls[0]).toBe("https://auth.atlassian.com/oauth/token");
		expect(ctx?.authorization).toBe("Bearer at-new");
		// Rotation: keeping the old one would break the next refresh.
		expect(readOdinConfig().jiraRefreshToken).toBe("r-new");
	});

	test("a refresh that returns no new refresh token keeps the old one", async () => {
		updateOdinConfig({
			jiraRefreshToken: "r-keep",
			jiraTokenExpiresAt: Date.now() - 1_000,
			jiraCloudId: "cloud-123",
		});
		mockFetch((url) =>
			url.includes("/oauth/token")
				? { access_token: "at-new", expires_in: 3600 }
				: [],
		);
		await jiraRequestContext();
		expect(readOdinConfig().jiraRefreshToken).toBe("r-keep");
	});

	test("a dead refresh token reads as not connected, so the pane says reconnect", async () => {
		updateOdinConfig({
			jiraRefreshToken: "r-dead",
			jiraTokenExpiresAt: Date.now() - 1_000,
		});
		mockFetch((url) =>
			url.includes("/oauth/token") ? { error: "invalid_grant" } : [],
		);
		expect(await jiraRequestContext()).toBeNull();
	});
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
