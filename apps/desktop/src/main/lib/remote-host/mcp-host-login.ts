import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * A sign-in of the host's own for one of Claude Code's connectors (any MCP
 * server signed in with OAuth). It runs the same OAuth flow Claude Code ran
 * here, with the client Claude Code registered and its localhost redirect:
 * the consent page opens in the browser, this computer catches the redirect,
 * and the sign-in, refresh token included, goes to the host and nowhere else.
 * The host's Claude Code refreshes it from then on, so the connector works
 * there with this computer shut. A second consent gives a second refresh
 * token; sharing this computer's one would sign the two out of each other.
 */

/** One connector's sign-in as Claude Code keeps it under `mcpOAuth`. */
export type McpEntry = Record<string, unknown> & {
	serverName?: string;
	serverUrl?: string;
	clientId?: string;
	clientSecret?: string;
	redirectUri?: string;
	scope?: string;
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	discoveryState?: {
		authorizationServerUrl?: string;
		authServerMetadataUrl?: string | null;
	};
};

/** The sign-ins in Claude Code's saved credentials that a host can get its own of. */
export function mcpLoginEntries(saved: string): Record<string, McpEntry> {
	let all: Record<string, McpEntry> = {};
	try {
		all = JSON.parse(saved).mcpOAuth ?? {};
	} catch {
		return {};
	}
	const out: Record<string, McpEntry> = {};
	for (const [key, entry] of Object.entries(all)) {
		if (
			entry?.accessToken &&
			entry.clientId &&
			entry.redirectUri &&
			entry.serverUrl &&
			LOCAL.has(safeUrl(entry.redirectUri)?.hostname ?? "")
		)
			out[key] = entry;
	}
	return out;
}

/** The name a person knows a connector by: "plugin:slack:slack" is "slack". */
export function mcpDisplayName(key: string, entry: McpEntry): string {
	const name = entry.serverName ?? key.split("|")[0] ?? key;
	return name.split(":").pop() || name;
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PENDING_TTL_MS = 10 * 60 * 1000;

type Result =
	| { status: "pending" }
	| { status: "connected" }
	| { status: "failed"; error: string };
const results = new Map<string, Result>();

export function readMcpHostLoginResult(state: string): Result | null {
	return results.get(state) ?? null;
}

function safeUrl(url: string): URL | null {
	try {
		return new URL(url);
	} catch {
		return null;
	}
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

interface AuthServer {
	authorization_endpoint: string;
	token_endpoint: string;
}

/** RFC 8414 discovery for the connector's authorization server, with the MCP spec's fallback. */
async function authServer(entry: McpEntry): Promise<AuthServer> {
	const issuer =
		entry.discoveryState?.authorizationServerUrl ??
		new URL(entry.serverUrl ?? "").origin;
	const base = new URL(issuer);
	const path = base.pathname.replace(/\/$/, "");
	const candidates = [
		entry.discoveryState?.authServerMetadataUrl,
		`${base.origin}/.well-known/oauth-authorization-server${path}`,
		`${base.origin}/.well-known/openid-configuration${path}`,
	].filter((url): url is string => Boolean(url));
	for (const url of candidates) {
		const meta = await fetch(url, { signal: AbortSignal.timeout(15_000) })
			.then((res) => (res.ok ? res.json() : null))
			.catch(() => null);
		if (meta?.authorization_endpoint && meta?.token_endpoint) return meta;
	}
	return {
		authorization_endpoint: `${base.origin}/authorize`,
		token_endpoint: `${base.origin}/token`,
	};
}

/** Listens on the redirect's port on both loopbacks, as the browser may pick either for "localhost". */
async function listenLoopback(
	port: number,
	handler: Parameters<typeof createServer>[1],
): Promise<Server[]> {
	const servers: Server[] = [];
	for (const host of ["127.0.0.1", "::1"]) {
		const server = createServer(handler);
		const ok = await new Promise<boolean>((resolve) => {
			server.once("error", () => resolve(false));
			server.listen(port, host, () => resolve(true));
		});
		if (ok) servers.push(server);
	}
	if (!servers.length)
		throw new Error(
			`Port ${port} is busy, so the sign-in can't come back. Try again in a minute.`,
		);
	return servers;
}

/**
 * Opens the connector's consent page; the sign-in that comes back is handed
 * to `deliver` whole, as Claude Code keeps it. Returns the state to poll
 * with readMcpHostLoginResult.
 */
export async function startMcpHostLogin(
	entry: McpEntry,
	open: (url: string) => Promise<void>,
	deliver: (signIn: McpEntry) => Promise<void>,
): Promise<{ state: string }> {
	const redirect = new URL(entry.redirectUri ?? "");
	const meta = await authServer(entry);
	const verifier = base64url(randomBytes(32));
	const state = base64url(randomBytes(16));
	results.set(state, { status: "pending" });
	const finish = (result: Result) => {
		results.set(state, result);
		setTimeout(() => results.delete(state), PENDING_TTL_MS).unref?.();
		for (const server of servers) server.close();
		clearTimeout(timer);
	};
	const servers = await listenLoopback(Number(redirect.port), (req, res) => {
		const url = new URL(req.url ?? "/", redirect);
		if (
			url.pathname !== redirect.pathname ||
			url.searchParams.get("state") !== state
		) {
			res.writeHead(404).end();
			return;
		}
		res
			.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
			.end("<p>Signed in for your Odin host. You can close this tab.</p>");
		const code = url.searchParams.get("code");
		if (!code) {
			finish({
				status: "failed",
				error: url.searchParams.get("error") ?? "No code came back",
			});
			return;
		}
		void exchange(entry, meta, code, verifier)
			.then(deliver)
			.then(
				() => finish({ status: "connected" }),
				(error: unknown) =>
					finish({
						status: "failed",
						error: error instanceof Error ? error.message : String(error),
					}),
			);
	});
	const timer = setTimeout(
		() => finish({ status: "failed", error: "Timed out" }),
		PENDING_TTL_MS,
	);
	const authorize = new URL(meta.authorization_endpoint);
	authorize.searchParams.set("response_type", "code");
	authorize.searchParams.set("client_id", entry.clientId ?? "");
	authorize.searchParams.set("redirect_uri", redirect.toString());
	authorize.searchParams.set("state", state);
	authorize.searchParams.set(
		"code_challenge",
		base64url(createHash("sha256").update(verifier).digest()),
	);
	authorize.searchParams.set("code_challenge_method", "S256");
	authorize.searchParams.set("resource", entry.serverUrl ?? "");
	if (entry.scope) authorize.searchParams.set("scope", entry.scope);
	await open(authorize.toString());
	return { state };
}

async function exchange(
	entry: McpEntry,
	meta: AuthServer,
	code: string,
	verifier: string,
): Promise<McpEntry> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: entry.redirectUri ?? "",
		client_id: entry.clientId ?? "",
		code_verifier: verifier,
		resource: entry.serverUrl ?? "",
	});
	if (entry.clientSecret) body.set("client_secret", entry.clientSecret);
	const res = await fetch(meta.token_endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body,
		signal: AbortSignal.timeout(30_000),
	});
	const got = (await res.json().catch(() => ({}))) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		scope?: string;
		error?: string;
		error_description?: string;
	};
	if (!got.access_token)
		throw new Error(
			`The sign-in was refused: ${got.error_description ?? got.error ?? `HTTP ${res.status}`}`,
		);
	if (!got.refresh_token)
		throw new Error(
			"This connector gives no refresh token, so the host can't keep it",
		);
	const { refreshToken: _mine, ...rest } = entry;
	return {
		...rest,
		accessToken: got.access_token,
		refreshToken: got.refresh_token,
		expiresAt: Date.now() + (got.expires_in ?? 3600) * 1000,
		...(got.scope && { scope: got.scope }),
	};
}
