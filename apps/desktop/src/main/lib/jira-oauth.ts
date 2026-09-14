import { randomUUID } from "node:crypto";
import {
	readOdinConfig,
	resolveJiraOAuthApp,
} from "../../lib/trpc/routers/odin-config";
import { type BrowserOpener, openInBrowser } from "./browser-opener";
import { jiraSite, storeJiraTokens } from "./jira-token";

/**
 * "Connect Jira" as two clicks, on the same bounce-page pattern as Slack and
 * Notion: Atlassian won't redirect to a custom scheme, so its callback URL is
 * a static page that forwards the code into `odin://oauth/jira`, and the
 * exchange happens here where the client secret lives.
 *
 * `offline_access` is what makes a refresh token come back; without it the
 * connection dies within the hour. `prompt=consent` forces the screen even on
 * a re-connect, so re-authorising actually reissues tokens.
 */

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";

/** What the My Jira feed needs, plus the refresh grant. */
const SCOPES = ["read:jira-work", "read:jira-user", "offline_access"];

const PENDING_TTL_MS = 10 * 60 * 1000;

type Pending =
	| { status: "pending"; startedAt: number; tokenAtStart: string | null }
	| { status: "connected"; startedAt: number; identity: string | null }
	| { status: "failed"; startedAt: number; error: string };

const pending = new Map<string, Pending>();

function sweep(): void {
	const cutoff = Date.now() - PENDING_TTL_MS;
	for (const [state, entry] of pending)
		if (entry.startedAt < cutoff) pending.delete(state);
}

export function isJiraOAuthConfigured(): boolean {
	return resolveJiraOAuthApp() !== null;
}

export async function startJiraOAuth(
	open: BrowserOpener = openInBrowser,
): Promise<{ state: string; authorizeUrl: string }> {
	const app = resolveJiraOAuthApp();
	if (!app) throw new Error("Jira OAuth is not configured");
	sweep();
	const state = randomUUID();
	pending.set(state, {
		status: "pending",
		startedAt: Date.now(),
		tokenAtStart: readOdinConfig().jiraRefreshToken ?? null,
	});
	const url = new URL(AUTHORIZE_URL);
	// Without this audience the token is for Atlassian's own APIs, not Jira's.
	url.searchParams.set("audience", "api.atlassian.com");
	url.searchParams.set("client_id", app.clientId);
	url.searchParams.set("scope", SCOPES.join(" "));
	url.searchParams.set("redirect_uri", app.redirectUrl);
	url.searchParams.set("state", state);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("prompt", "consent");
	const authorizeUrl = url.toString();
	await open(authorizeUrl);
	return { state, authorizeUrl };
}

export function readJiraOAuthResult(state: string): Pending | null {
	sweep();
	const entry = pending.get(state);
	if (!entry) return null;
	// Finished in a sibling Odin, which writes the same odin.json.
	if (
		entry.status === "pending" &&
		(readOdinConfig().jiraRefreshToken ?? null) !== entry.tokenAtStart
	) {
		const connected: Pending = {
			status: "connected",
			startedAt: entry.startedAt,
			identity: null,
		};
		pending.set(state, connected);
		return connected;
	}
	return entry;
}

export function isJiraOAuthCallback(url: string): boolean {
	return /:\/\/oauth\/jira\b/.test(url);
}

/** Handle `odin://oauth/jira?code=…&state=…`. */
export async function completeJiraOAuth(url: string): Promise<void> {
	const params = new URL(url).searchParams;
	const state = params.get("state");
	if (!state || !pending.has(state)) {
		console.error("[jira-oauth] Callback with unknown or expired state");
		return;
	}
	const startedAt = pending.get(state)?.startedAt ?? Date.now();
	const fail = (error: string) => {
		console.error("[jira-oauth]", error);
		pending.set(state, { status: "failed", startedAt, error });
	};

	const denied = params.get("error");
	if (denied) return fail(denied);
	const code = params.get("code");
	if (!code) return fail("Jira callback had no code");
	const app = resolveJiraOAuthApp();
	if (!app) return fail("Jira OAuth is not configured");

	try {
		const res = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "authorization_code",
				client_id: app.clientId,
				client_secret: app.clientSecret,
				code,
				redirect_uri: app.redirectUrl,
			}),
		});
		const json = (await res.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			error?: string;
			error_description?: string;
		};
		const access = storeJiraTokens(json);
		if (!access) {
			return fail(
				`Jira rejected the exchange: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`,
			);
		}
		if (!json.refresh_token) {
			// Without offline_access the connection would expire within the hour
			// and there would be nothing to renew it with.
			return fail("Jira returned no refresh token — offline_access is missing");
		}
		// Resolve the site now, so the first feed request isn't doing it.
		const site = await jiraSite(access);
		pending.set(state, {
			status: "connected",
			startedAt,
			identity: site?.siteUrl ?? null,
		});
		console.log("[jira-oauth] Connected");
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}
