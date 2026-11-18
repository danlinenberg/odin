import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	readOdinConfig,
	resolveAirtableOAuthApp,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";
import { type BrowserOpener, openInBrowser } from "./browser-opener";

/**
 * "Sign in with Airtable", on the same bounce-page pattern as Calendar: the
 * Redirect URI is a static page that forwards the code into
 * `odin://oauth/airtable`, and the exchange happens here. Airtable requires
 * PKCE, so each sign-in keeps its own code verifier until the callback.
 *
 * Access tokens last an hour; refresh tokens last 60 days and rotate, so
 * every refresh stores the new one. Kept free of electron: the work and
 * connections routers import it.
 */

const AUTHORIZE_URL = "https://airtable.com/oauth2/v1/authorize";
const TOKEN_URL = "https://airtable.com/oauth2/v1/token";

/** Read-only: records, the tables' fields (for titles), and who signed in. */
const SCOPES = ["data.records:read", "schema.bases:read", "user.email:read"];

const PENDING_TTL_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 60_000;

type Pending =
	| {
			status: "pending";
			startedAt: number;
			verifier: string;
			tokenAtStart: string | null;
	  }
	| { status: "connected"; startedAt: number; identity: string | null }
	| { status: "failed"; startedAt: number; error: string };

const pending = new Map<string, Pending>();

function sweep(): void {
	const cutoff = Date.now() - PENDING_TTL_MS;
	for (const [state, entry] of pending)
		if (entry.startedAt < cutoff) pending.delete(state);
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

export function isAirtableOAuthConfigured(): boolean {
	return resolveAirtableOAuthApp() !== null;
}

/** True when signed in to Airtable. */
export function hasAirtableOAuth(): boolean {
	return (
		isAirtableOAuthConfigured() &&
		Boolean(readOdinConfig().airtableRefreshToken)
	);
}

/** The PKCE pair: a random verifier and its SHA-256 challenge, both base64url. */
export function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(48).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

export async function startAirtableOAuth(
	open: BrowserOpener = openInBrowser,
): Promise<{ state: string; authorizeUrl: string }> {
	const app = resolveAirtableOAuthApp();
	if (!app) throw new Error("Airtable OAuth is not configured");
	sweep();
	const state = randomUUID();
	const { verifier, challenge } = pkcePair();
	pending.set(state, {
		status: "pending",
		startedAt: Date.now(),
		verifier,
		tokenAtStart: readOdinConfig().airtableRefreshToken ?? null,
	});
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("client_id", app.clientId);
	url.searchParams.set("redirect_uri", app.redirectUrl);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", SCOPES.join(" "));
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	const authorizeUrl = url.toString();
	await open(authorizeUrl);
	return { state, authorizeUrl };
}

export function readAirtableOAuthResult(
	state: string,
): Exclude<Pending, { status: "pending" }> | { status: "pending" } | null {
	sweep();
	const entry = pending.get(state);
	if (!entry) return null;
	// Finished in a sibling Odin, which writes the same odin.json.
	if (
		entry.status === "pending" &&
		(readOdinConfig().airtableRefreshToken ?? null) !== entry.tokenAtStart
	) {
		const connected: Pending = {
			status: "connected",
			startedAt: entry.startedAt,
			identity: null,
		};
		pending.set(state, connected);
		return connected;
	}
	return entry.status === "pending" ? { status: "pending" } : entry;
}

export function isAirtableOAuthCallback(url: string): boolean {
	return /:\/\/oauth\/airtable\b/.test(url);
}

/** POST to the token endpoint, with the client secret as Basic auth when the app has one. */
async function tokenRequest(body: Record<string, string>): Promise<{
	status: number;
	json: TokenResponse;
}> {
	const app = resolveAirtableOAuthApp();
	if (!app) throw new Error("Airtable OAuth is not configured");
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`,
		},
		body: new URLSearchParams({ client_id: app.clientId, ...body }),
	});
	return { status: res.status, json: (await res.json()) as TokenResponse };
}

function storeTokens(json: TokenResponse): string | null {
	if (!json.access_token) return null;
	updateOdinConfig({
		airtableAccessToken: json.access_token,
		airtableRefreshToken:
			json.refresh_token ?? readOdinConfig().airtableRefreshToken,
		airtableTokenExpiresAt: json.expires_in
			? Date.now() + json.expires_in * 1000
			: undefined,
	});
	return json.access_token;
}

/** Handle `odin://oauth/airtable?code=…&state=…`. */
export async function completeAirtableOAuth(url: string): Promise<void> {
	const params = new URL(url).searchParams;
	const state = params.get("state");
	const entry = state ? pending.get(state) : undefined;
	if (!state || !entry) {
		console.error("[airtable-oauth] Callback with unknown or expired state");
		return;
	}
	const startedAt = entry.startedAt;
	const fail = (error: string) => {
		console.error("[airtable-oauth]", error);
		pending.set(state, { status: "failed", startedAt, error });
	};
	if (entry.status !== "pending") return;

	const denied = params.get("error");
	if (denied) return fail(params.get("error_description") ?? denied);
	const code = params.get("code");
	if (!code) return fail("Airtable callback had no code");
	const app = resolveAirtableOAuthApp();
	if (!app) return fail("Airtable OAuth is not configured");

	try {
		const { status, json } = await tokenRequest({
			grant_type: "authorization_code",
			code,
			code_verifier: entry.verifier,
			redirect_uri: app.redirectUrl,
		});
		if (!json.refresh_token) {
			return fail(
				`Airtable rejected the exchange: ${json.error_description ?? json.error ?? `HTTP ${status}`}`,
			);
		}
		const access = storeTokens(json);
		let identity: string | null = null;
		if (access) {
			const me = await fetch("https://api.airtable.com/v0/meta/whoami", {
				headers: { Authorization: `Bearer ${access}` },
			});
			if (me.ok)
				identity = ((await me.json()) as { email?: string }).email ?? null;
		}
		pending.set(state, { status: "connected", startedAt, identity });
		console.log("[airtable-oauth] Connected");
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}

/** One refresh at a time: refresh tokens rotate, so two at once would burn one. */
let refreshing: Promise<string | null> | null = null;

async function refresh(): Promise<string | null> {
	const refreshToken = readOdinConfig().airtableRefreshToken;
	if (!refreshToken) return null;
	try {
		const { json } = await tokenRequest({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		});
		if (!json.access_token) {
			console.error("[airtable-oauth] Refresh failed:", json.error);
			return null;
		}
		return storeTokens(json);
	} catch (error) {
		console.error("[airtable-oauth] Refresh failed:", error);
		return null;
	}
}

/**
 * A usable access token, refreshed when it is spent or nearly so. Null when
 * Airtable isn't signed in.
 */
export async function airtableAccessToken(): Promise<string | null> {
	if (!hasAirtableOAuth()) return null;
	const { airtableAccessToken: stored, airtableTokenExpiresAt } =
		readOdinConfig();
	if (
		stored &&
		airtableTokenExpiresAt &&
		airtableTokenExpiresAt - REFRESH_MARGIN_MS > Date.now()
	)
		return stored;
	refreshing ??= refresh().finally(() => {
		refreshing = null;
	});
	return refreshing;
}
