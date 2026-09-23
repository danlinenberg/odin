import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readOdinConfig,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";
import { githubAccessToken, githubApiFetch } from "./github-token";

const dir = mkdtempSync(join(tmpdir(), "github-token-"));
process.env.ODIN_CONFIG_PATH = join(dir, "odin.json");

const originalFetch = globalThis.fetch;

beforeEach(() => {
	updateOdinConfig({
		githubClientId: "Ov23test",
		githubToken: undefined,
		githubRefreshToken: undefined,
		githubTokenExpiresAt: undefined,
	});
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockFetch(body: unknown) {
	const calls: { url: string; body: string }[] = [];
	globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), body: String(init?.body ?? "") });
		return new Response(JSON.stringify(body));
	}) as unknown as typeof fetch;
	return calls;
}

describe("githubAccessToken", () => {
	test("null when GitHub isn't connected", async () => {
		expect(await githubAccessToken()).toBeNull();
	});

	test("a token with no expiry is used as-is — that app doesn't expire them", async () => {
		updateOdinConfig({ githubToken: "gho_forever" });
		const calls = mockFetch({});
		expect(await githubAccessToken()).toBe("gho_forever");
		expect(calls).toHaveLength(0);
	});

	test("an unexpired token is used as-is", async () => {
		updateOdinConfig({
			githubToken: "gho_live",
			githubRefreshToken: "ghr_1",
			githubTokenExpiresAt: Date.now() + 3_600_000,
		});
		const calls = mockFetch({});
		expect(await githubAccessToken()).toBe("gho_live");
		expect(calls).toHaveLength(0);
	});

	test("an expired token is refreshed, and the refresh token rotates", async () => {
		updateOdinConfig({
			githubToken: "gho_stale",
			githubRefreshToken: "ghr_old",
			githubTokenExpiresAt: Date.now() - 1_000,
		});
		const calls = mockFetch({
			access_token: "gho_new",
			refresh_token: "ghr_new",
			expires_in: 28_800,
		});
		expect(await githubAccessToken()).toBe("gho_new");
		expect(calls[0].url).toBe("https://github.com/login/oauth/access_token");
		// Device-flow refreshes are exempt from the client secret, which is
		// the only reason a desktop app can do this at all.
		expect(calls[0].body).not.toContain("client_secret");
		// Rotation: keeping the old one would break the next refresh.
		expect(readOdinConfig().githubRefreshToken).toBe("ghr_new");
		expect(readOdinConfig().githubTokenExpiresAt).toBeGreaterThan(Date.now());
	});

	test("a dead refresh token falls back to the stored token, so the pane says reconnect", async () => {
		updateOdinConfig({
			githubToken: "gho_stale",
			githubRefreshToken: "ghr_dead",
			githubTokenExpiresAt: Date.now() - 1_000,
		});
		mockFetch({ error: "bad_refresh_token" });
		expect(await githubAccessToken()).toBe("gho_stale");
	});
});

/**
 * A stand-in `gh` on PATH, so the fallback is exercised for real rather than
 * against a mock of our own shelling-out.
 */
function stubGhCli(body: string): void {
	const bin = join(dir, "bin");
	rmSync(bin, { recursive: true, force: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "gh"), `#!/bin/sh\n${body}\n`);
	chmodSync(join(bin, "gh"), 0o755);
	process.env.PATH = `${bin}:${process.env.PATH}`;
}

describe("githubApiFetch", () => {
	test("a rejected token is retried with the gh CLI's token for the same login", async () => {
		updateOdinConfig({ githubLogin: "octocat" });
		stubGhCli('[ "$4" = "octocat" ] && echo gho_from_cli');
		const seen: string[] = [];
		globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
			const auth = String(
				(init?.headers as Record<string, string>)?.Authorization,
			);
			seen.push(auth);
			return new Response("{}", { status: auth.endsWith("dead") ? 401 : 200 });
		}) as unknown as typeof fetch;

		const res = await githubApiFetch("https://api.github.com/user", {}, "dead");
		expect(res.status).toBe(200);
		expect(seen).toEqual(["Bearer dead", "Bearer gho_from_cli"]);
	});

	test("a token the CLI rescued is not sent again", async () => {
		updateOdinConfig({ githubLogin: "octocat" });
		stubGhCli("echo gho_from_cli");
		const seen: string[] = [];
		globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
			const auth = String(
				(init?.headers as Record<string, string>)?.Authorization,
			);
			seen.push(auth);
			return new Response("{}", {
				status: auth.endsWith("revoked") ? 401 : 200,
			});
		}) as unknown as typeof fetch;

		await githubApiFetch("https://x.test", {}, "revoked");
		await githubApiFetch("https://x.test", {}, "revoked");
		expect(seen).toEqual([
			"Bearer revoked",
			"Bearer gho_from_cli",
			"Bearer gho_from_cli",
		]);
	});

	test("a 403 is returned as-is — the CLI token would hit the same wall", async () => {
		updateOdinConfig({ githubLogin: "octocat" });
		stubGhCli("echo gho_from_cli");
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return new Response("rate limit", { status: 403 });
		}) as unknown as typeof fetch;

		expect((await githubApiFetch("https://x.test", {}, "t")).status).toBe(403);
		expect(calls).toBe(1);
	});

	test("no gh CLI leaves the 401 to surface as 'reconnect'", async () => {
		updateOdinConfig({ githubLogin: "octocat" });
		stubGhCli("exit 1");
		globalThis.fetch = mock(
			async () => new Response("{}", { status: 401 }),
		) as unknown as typeof fetch;
		expect((await githubApiFetch("https://x.test", {}, "t")).status).toBe(401);
	});
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
