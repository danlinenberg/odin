import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	type McpEntry,
	mcpDisplayName,
	mcpLoginEntries,
	readMcpHostLoginResult,
	startMcpHostLogin,
} from "./mcp-host-login";

// A connector's authorization server: RFC 8414 metadata and a token endpoint that checks PKCE.
const exchanges: URLSearchParams[] = [];
let challenge = "";
let authPort = 0;
const auth = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: async (req: Request): Promise<Response> => {
		const path = new URL(req.url).pathname;
		if (path === "/.well-known/oauth-authorization-server")
			return Response.json({
				authorization_endpoint: `http://127.0.0.1:${authPort}/authorize`,
				token_endpoint: `http://127.0.0.1:${authPort}/token`,
			});
		if (path === "/token") {
			const body = new URLSearchParams(await req.text());
			exchanges.push(body);
			const verifier = body.get("code_verifier") ?? "";
			if (
				createHash("sha256").update(verifier).digest("base64url") !== challenge
			)
				return Response.json({ error: "invalid_grant" }, { status: 400 });
			return Response.json({
				access_token: "host_a",
				refresh_token: "host_r",
				expires_in: 3600,
			});
		}
		return new Response("", { status: 404 });
	},
});
authPort = auth.port ?? 0;
afterAll(() => auth.stop(true));

// A free port for the redirect, as Claude Code registered it.
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const redirectPort = probe.port;
probe.stop(true);

const entry: McpEntry = {
	serverName: "plugin:slack:slack",
	serverUrl: "https://mcp.example.com/mcp",
	clientId: "client1",
	redirectUri: `http://localhost:${redirectPort}/callback`,
	scope: "read",
	accessToken: "mine_a",
	refreshToken: "mine_r",
	expiresAt: 1,
	discoveryState: { authorizationServerUrl: `http://127.0.0.1:${auth.port}` },
};

test("only sign-ins with a client and a localhost redirect can get a host sign-in of their own", () => {
	const saved = JSON.stringify({
		mcpOAuth: {
			"plugin:slack:slack|a": entry,
			"remote|b": { ...entry, redirectUri: "https://example.com/cb" },
			"half|c": { accessToken: "x" },
		},
	});
	expect(Object.keys(mcpLoginEntries(saved))).toEqual(["plugin:slack:slack|a"]);
	expect(mcpLoginEntries("not json")).toEqual({});
	expect(mcpDisplayName("plugin:slack:slack|a", entry)).toBe("slack");
});

test("the host's own sign-in comes back through the redirect, with PKCE, and goes whole to the host", async () => {
	const delivered: McpEntry[] = [];
	const { state } = await startMcpHostLogin(
		entry,
		async (url) => {
			// The browser: the consent page redirects back with a code.
			const authorize = new URL(url);
			expect(authorize.searchParams.get("client_id")).toBe("client1");
			expect(authorize.searchParams.get("resource")).toBe(
				entry.serverUrl ?? null,
			);
			expect(authorize.searchParams.get("scope")).toBe("read");
			challenge = authorize.searchParams.get("code_challenge") ?? "";
			const back = new URL(authorize.searchParams.get("redirect_uri") ?? "");
			back.searchParams.set("code", "c1");
			back.searchParams.set("state", authorize.searchParams.get("state") ?? "");
			setTimeout(
				() => void fetch(back.toString().replace("localhost", "127.0.0.1")),
				10,
			);
		},
		async (signIn) => {
			delivered.push(signIn);
		},
	);
	for (
		let i = 0;
		i < 100 && readMcpHostLoginResult(state)?.status === "pending";
		i++
	)
		await Bun.sleep(20);
	expect(readMcpHostLoginResult(state)).toEqual({ status: "connected" });
	expect(exchanges.at(-1)?.get("code")).toBe("c1");
	expect(delivered).toEqual([
		{
			...entry,
			accessToken: "host_a",
			refreshToken: "host_r",
			expiresAt: expect.any(Number),
		},
	]);
	// This computer's refresh token never left: the host's is its own.
	expect(delivered[0]?.refreshToken).not.toBe("mine_r");
});
