import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readOdinConfig,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";
import {
	completeSlackOAuth,
	isSlackOAuthCallback,
	isSlackOAuthConfigured,
	readSlackOAuthResult,
	startSlackOAuth,
} from "./slack-oauth";

const dir = mkdtempSync(join(tmpdir(), "slack-oauth-"));
process.env.ODIN_CONFIG_PATH = join(dir, "odin.json");

const originalFetch = globalThis.fetch;

// Injected instead of asserting on electron's shell: see browser-opener.ts.
let opened: string[] = [];
const capture = async (url: string) => {
	opened.push(url);
};

beforeEach(() => {
	opened = [];
	updateOdinConfig({
		slackClientId: "cid",
		slackClientSecret: "csecret",
		slackRedirectUrl: "https://example.test/slack.html",
		slackToken: undefined,
	});
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockExchange(body: unknown) {
	const calls: { url: string; params: URLSearchParams }[] = [];
	globalThis.fetch = mock(async (url: string, init: RequestInit) => {
		calls.push({
			url: String(url),
			params: new URLSearchParams(String(init.body)),
		});
		return new Response(JSON.stringify(body));
	}) as unknown as typeof fetch;
	return calls;
}

describe("isSlackOAuthCallback", () => {
	test("matches the callback deep link only", () => {
		expect(isSlackOAuthCallback("odin://oauth/slack?code=x")).toBe(true);
		expect(isSlackOAuthCallback("odin://tasks/my-slug")).toBe(false);
		// Must not swallow the sign-in deep link the app already handles.
		expect(isSlackOAuthCallback("odin://auth?token=x")).toBe(false);
	});

	test("does not care which scheme delivered it", () => {
		// The matcher keys on the path, so a redirect page still pointing at the
		// old odin-odin:// scheme is handled rather than dropped.
		expect(isSlackOAuthCallback("odin-odin://oauth/slack?code=x")).toBe(true);
		expect(isSlackOAuthCallback("odin-odin://auth?token=x")).toBe(false);
	});
});

describe("startSlackOAuth", () => {
	test("opens the consent screen with user scopes and our state", async () => {
		const { state } = await startSlackOAuth(capture);
		const url = new URL(opened[0]);
		expect(url.origin + url.pathname).toBe(
			"https://slack.com/oauth/v2/authorize",
		);
		expect(url.searchParams.get("state")).toBe(state);
		expect(url.searchParams.get("user_scope")).toContain("reactions:read");
		// Bot scopes would mean an app that must be invited to every channel.
		expect(url.searchParams.get("scope")).toBeNull();
		expect(url.searchParams.get("redirect_uri")).toBe(
			"https://example.test/slack.html",
		);
		expect(readSlackOAuthResult(state)?.status).toBe("pending");
	});

	test("refuses to start when no app is configured", async () => {
		updateOdinConfig({
			slackClientId: undefined,
			slackClientSecret: undefined,
			slackRedirectUrl: undefined,
		});
		expect(isSlackOAuthConfigured()).toBe(false);
		await expect(startSlackOAuth()).rejects.toThrow("not configured");
	});
});

describe("completeSlackOAuth", () => {
	test("stores the user token from a callback we started", async () => {
		const { state } = await startSlackOAuth(capture);
		const calls = mockExchange({
			ok: true,
			team: { name: "Imagen" },
			authed_user: { access_token: "xoxp-real", token_type: "user" },
		});
		await completeSlackOAuth(`odin-odin://oauth/slack?code=abc&state=${state}`);
		expect(calls[0].url).toBe("https://slack.com/api/oauth.v2.access");
		expect(calls[0].params.get("code")).toBe("abc");
		// Slack rejects the exchange if this doesn't match the authorize call.
		expect(calls[0].params.get("redirect_uri")).toBe(
			"https://example.test/slack.html",
		);
		expect(readOdinConfig().slackToken).toBe("xoxp-real");
		expect(readSlackOAuthResult(state)).toMatchObject({
			status: "connected",
			identity: "Imagen",
		});
	});

	test("ignores a callback whose state we never issued", async () => {
		const calls = mockExchange({ ok: true });
		await completeSlackOAuth(
			"odin-odin://oauth/slack?code=attacker&state=not-ours",
		);
		// No exchange at all — an unsolicited code must never reach Slack.
		expect(calls).toHaveLength(0);
		expect(readOdinConfig().slackToken).toBeUndefined();
	});

	test("a bot-only install is a failure, not a silent empty feed", async () => {
		const { state } = await startSlackOAuth(capture);
		mockExchange({ ok: true, access_token: "xoxb-bot" });
		await completeSlackOAuth(`odin-odin://oauth/slack?code=abc&state=${state}`);
		expect(readOdinConfig().slackToken).toBeUndefined();
		expect(readSlackOAuthResult(state)).toMatchObject({ status: "failed" });
	});

	test("a declined consent screen reports the reason", async () => {
		const { state } = await startSlackOAuth(capture);
		const calls = mockExchange({ ok: true });
		await completeSlackOAuth(
			`odin-odin://oauth/slack?error=access_denied&state=${state}`,
		);
		expect(calls).toHaveLength(0);
		expect(readSlackOAuthResult(state)).toMatchObject({
			status: "failed",
			error: "access_denied",
		});
	});

	test("Slack rejecting the exchange leaves the old token alone", async () => {
		updateOdinConfig({ slackToken: "xoxp-existing" });
		const { state } = await startSlackOAuth(capture);
		mockExchange({ ok: false, error: "invalid_code" });
		await completeSlackOAuth(
			`odin-odin://oauth/slack?code=stale&state=${state}`,
		);
		expect(readOdinConfig().slackToken).toBe("xoxp-existing");
		expect(readSlackOAuthResult(state)?.status).toBe("failed");
	});
});

describe("baked-in credentials", () => {
	test("a build with credentials compiled in needs no local config", () => {
		updateOdinConfig({
			slackClientId: undefined,
			slackClientSecret: undefined,
			slackRedirectUrl: undefined,
		});
		expect(isSlackOAuthConfigured()).toBe(false);
		// What electron.vite.config.ts substitutes into a packaged build.
		process.env.ODIN_SLACK_CLIENT_ID_BAKED = "baked-id";
		process.env.ODIN_SLACK_CLIENT_SECRET_BAKED = "baked-secret";
		process.env.ODIN_SLACK_REDIRECT_URL_BAKED = "https://baked.test/slack.html";
		try {
			expect(isSlackOAuthConfigured()).toBe(true);
		} finally {
			delete process.env.ODIN_SLACK_CLIENT_ID_BAKED;
			delete process.env.ODIN_SLACK_CLIENT_SECRET_BAKED;
			delete process.env.ODIN_SLACK_REDIRECT_URL_BAKED;
		}
	});

	test("local config still overrides a baked build", async () => {
		process.env.ODIN_SLACK_REDIRECT_URL_BAKED = "https://baked.test/slack.html";
		try {
			const { state, authorizeUrl } = await startSlackOAuth(capture);
			expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(
				"https://example.test/slack.html",
			);
			expect(state).toBeTruthy();
		} finally {
			delete process.env.ODIN_SLACK_REDIRECT_URL_BAKED;
		}
	});
});

describe("a sibling Odin handling the callback", () => {
	test("the waiting app adopts a token that appeared underneath it", async () => {
		const { state } = await startSlackOAuth(capture);
		expect(readSlackOAuthResult(state)?.status).toBe("pending");
		// Both builds register odin-odin:// and share odin.json, so the other
		// one may have completed the exchange.
		updateOdinConfig({ slackToken: "xoxp-from-the-other-app" });
		expect(readSlackOAuthResult(state)?.status).toBe("connected");
	});

	test("an unchanged token keeps the flow pending", async () => {
		updateOdinConfig({ slackToken: "xoxp-unchanged" });
		const { state } = await startSlackOAuth(capture);
		expect(readSlackOAuthResult(state)?.status).toBe("pending");
	});
});

// Keep the temp config out of the developer's home directory.
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
