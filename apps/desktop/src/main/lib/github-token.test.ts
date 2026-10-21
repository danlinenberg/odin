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
import {
	connectGithubAccount,
	disconnectGithubAccount,
	githubAccessToken,
	githubAccountTokens,
	githubApiFetch,
	githubOwner,
	githubTokenForLogin,
	onGithubTokensChanged,
	storeGithubTokens,
	tokenOrder,
} from "./github-token";

const dir = mkdtempSync(join(tmpdir(), "github-token-"));
process.env.ODIN_CONFIG_PATH = join(dir, "odin.json");

const originalFetch = globalThis.fetch;

beforeEach(() => {
	updateOdinConfig({
		githubClientId: "Ov23test",
		githubToken: undefined,
		githubRefreshToken: undefined,
		githubTokenExpiresAt: undefined,
		githubLogin: undefined,
		githubAccounts: undefined,
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

	test("a margin asks for a token good that long: a copy for the remote host must outlive the gap to the next", async () => {
		updateOdinConfig({
			githubToken: "gho_short",
			githubRefreshToken: "ghr_1",
			githubTokenExpiresAt: Date.now() + 10 * 60_000,
		});
		const calls = mockFetch({
			access_token: "gho_long",
			refresh_token: "ghr_2",
			expires_in: 28_800,
		});
		expect(await githubAccessToken()).toBe("gho_short");
		expect(calls).toHaveLength(0);
		expect(await githubAccessToken(45 * 60_000)).toBe("gho_long");
		expect(calls).toHaveLength(1);
		updateOdinConfig({
			githubLogin: "main",
			githubAccounts: [
				{
					login: "extra",
					token: "gho_extra",
					refreshToken: "ghr_x",
					expiresAt: Date.now() + 10 * 60_000,
				},
			],
		});
		expect(await githubTokenForLogin("extra", 45 * 60_000)).toBe("gho_long");
		expect(calls).toHaveLength(2);
	});

	test("a stored token is announced, so the remote host gets a fresh copy", () => {
		let heard = 0;
		const off = onGithubTokensChanged(() => {
			heard += 1;
		});
		storeGithubTokens({ access_token: "gho_1" });
		expect(heard).toBe(1);
		storeGithubTokens({});
		expect(heard).toBe(1);
		off();
		storeGithubTokens({ access_token: "gho_2" });
		expect(heard).toBe(1);
	});

	test("a token with no expiry is used as-is - that app doesn't expire them", async () => {
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

	test("a 403 is returned as-is - the CLI token would hit the same wall", async () => {
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

describe("more than one GitHub account", () => {
	const WORK = { login: "dan-work", token: "gho_work" };
	const auth = (init?: RequestInit) =>
		String((init?.headers as Record<string, string>)?.Authorization);

	test("the owner comes from an API or a web URL", () => {
		expect(githubOwner("https://api.github.com/repos/ImagenAI/x/pulls/1")).toBe(
			"imagenai",
		);
		expect(githubOwner("https://github.com/danlinenberg/odin/pull/2")).toBe(
			"danlinenberg",
		);
		expect(githubOwner("https://api.github.com/user")).toBeNull();
	});

	test("the account that last worked for an owner goes first, the caller's token next", () => {
		const accounts = [
			{ login: "me", token: "gho_me" },
			{ login: "dan-work", token: "gho_work" },
		];
		const order = tokenOrder(
			"https://api.github.com/repos/imagenai/x/pulls/1",
			"gho_me",
			accounts,
			new Map([["imagenai", "dan-work"]]),
		);
		expect(order.map((a) => a.token)).toEqual(["gho_work", "gho_me"]);
	});

	test("an old config with one connection still reads as one account", async () => {
		updateOdinConfig({ githubToken: "gho_me", githubLogin: "me" });
		expect(await githubAccountTokens()).toEqual([
			{ login: "me", token: "gho_me" },
		]);
	});

	test("a repo the main account can't see is read with the other account", async () => {
		updateOdinConfig({
			githubToken: "gho_me",
			githubLogin: "me",
			githubAccounts: [WORK],
		});
		const seen: string[] = [];
		globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
			seen.push(auth(init));
			return new Response("{}", {
				status: auth(init).endsWith("work") ? 200 : 404,
			});
		}) as unknown as typeof fetch;
		const url = "https://api.github.com/repos/imagenai/app/pulls/7";
		expect((await githubApiFetch(url, {}, "gho_me")).status).toBe(200);
		expect((await githubApiFetch(url, {}, "gho_me")).status).toBe(200);
		// The second call goes straight to the account that worked.
		expect(seen).toEqual([
			"Bearer gho_me",
			"Bearer gho_work",
			"Bearer gho_work",
		]);
	});

	test("adding an account keeps the main one; signing in as the same login replaces it", async () => {
		updateOdinConfig({ githubToken: "gho_me", githubLogin: "me" });
		globalThis.fetch = mock(
			async (_url: string, init?: RequestInit) =>
				new Response(
					JSON.stringify({
						login: auth(init).endsWith("work") ? "dan-work" : "me",
					}),
				),
		) as unknown as typeof fetch;
		await connectGithubAccount({ access_token: "gho_work" }, true);
		expect(readOdinConfig().githubToken).toBe("gho_me");
		expect(readOdinConfig().githubAccounts).toEqual([
			{
				login: "dan-work",
				token: "gho_work",
				refreshToken: undefined,
				expiresAt: undefined,
			},
		]);
		await connectGithubAccount({ access_token: "gho_me2" }, true);
		expect(readOdinConfig().githubToken).toBe("gho_me2");
		expect(readOdinConfig().githubAccounts).toHaveLength(1);
	});

	test("removing the main account promotes the next one", () => {
		updateOdinConfig({
			githubToken: "gho_me",
			githubLogin: "me",
			githubAccounts: [WORK],
		});
		disconnectGithubAccount("me");
		expect(readOdinConfig().githubToken).toBe("gho_work");
		expect(readOdinConfig().githubLogin).toBe("dan-work");
		expect(readOdinConfig().githubAccounts).toBeUndefined();
	});
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
