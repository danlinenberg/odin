import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readOdinConfig,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";
import {
	completeClickupOAuth,
	readClickupOAuthResult,
	startClickupOAuth,
} from "./clickup-oauth";

process.env.ODIN_CONFIG_PATH = join(
	mkdtempSync(join(tmpdir(), "clickup-oauth-")),
	"odin.json",
);
const originalFetch = globalThis.fetch;

beforeEach(() => {
	updateOdinConfig({
		clickupClientId: "cid",
		clickupClientSecret: "csecret",
		clickupRedirectUrl: "https://example.test/clickup.html",
		clickupToken: undefined,
	});
});
afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("a consent round trip stores the token; a stranger's state is dropped", async () => {
	const { state, authorizeUrl } = await startClickupOAuth(async () => {});
	expect(new URL(authorizeUrl).searchParams.get("state")).toBe(state);

	const calls: string[] = [];
	globalThis.fetch = mock(async (url: string | URL) => {
		calls.push(String(url));
		return new Response(
			String(url).includes("oauth/token")
				? JSON.stringify({ access_token: "tok" })
				: JSON.stringify({ user: { username: "dan" } }),
		);
	}) as unknown as typeof fetch;

	await completeClickupOAuth("odin://oauth/clickup?code=c&state=someone-else");
	expect(calls).toEqual([]);

	await completeClickupOAuth(`odin://oauth/clickup?code=c&state=${state}`);
	expect(calls[0]).toContain("client_secret=csecret");
	expect(readOdinConfig().clickupToken).toBe("tok");
	expect(readClickupOAuthResult(state)).toMatchObject({
		status: "connected",
		identity: "dan",
	});
});
