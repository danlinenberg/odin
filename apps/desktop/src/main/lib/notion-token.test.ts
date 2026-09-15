import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readOdinConfig,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";
import { refreshNotionToken } from "./notion-token";

const dir = mkdtempSync(join(tmpdir(), "notion-token-"));
process.env.ODIN_CONFIG_PATH = join(dir, "odin.json");

const originalFetch = globalThis.fetch;

beforeEach(() => {
	updateOdinConfig({
		notionClientId: "cid",
		notionClientSecret: "csecret",
		notionRedirectUrl: "https://example.test/notion.html",
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

describe("refreshNotionToken", () => {
	test("rotates both tokens", async () => {
		updateOdinConfig({
			notionToken: "ntn_old",
			notionRefreshToken: "refresh_old",
		});
		const calls = mockTokenEndpoint({
			access_token: "ntn_new",
			refresh_token: "refresh_new",
		});
		expect(await refreshNotionToken()).toBe("ntn_new");
		expect(calls[0].body).toMatchObject({
			grant_type: "refresh_token",
			refresh_token: "refresh_old",
		});
		expect(readOdinConfig().notionRefreshToken).toBe("refresh_new");
	});

	test("keeps the old refresh token when Notion doesn't return a new one", async () => {
		updateOdinConfig({ notionRefreshToken: "refresh_keep" });
		mockTokenEndpoint({ access_token: "ntn_new" });
		expect(await refreshNotionToken()).toBe("ntn_new");
		expect(readOdinConfig().notionRefreshToken).toBe("refresh_keep");
	});

	test("a pasted internal secret has nothing to refresh", async () => {
		// The paste path stores no refresh token, and its secret never expires —
		// so the retry must be inert rather than clobbering anything.
		updateOdinConfig({ notionRefreshToken: undefined });
		const calls = mockTokenEndpoint({ access_token: "should-not-happen" });
		expect(await refreshNotionToken()).toBeNull();
		expect(calls).toHaveLength(0);
	});
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
