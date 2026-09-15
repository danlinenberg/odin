import {
	readOdinConfig,
	resolveJiraOAuthApp,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";

/**
 * Jira OAuth token upkeep, deliberately separate from the consent flow.
 *
 * Atlassian 3LO differs from Slack and Notion in two ways that shape this
 * file. Access tokens are short-lived and the refresh token *rotates* — every
 * refresh issues a new one and invalidates the old — so the stored pair must
 * be replaced atomically or the connection is lost. And OAuth calls do not go
 * to your site host: they go to api.atlassian.com/ex/jira/{cloudId}, where the
 * cloudId comes from asking which sites the token can reach.
 *
 * Kept free of electron: the work router imports this, and that router is
 * loaded almost everywhere.
 */

const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const RESOURCES_URL =
	"https://api.atlassian.com/oauth/token/accessible-resources";

/** Refresh this far before expiry, so a call in flight doesn't age out. */
const REFRESH_MARGIN_MS = 60_000;

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

/** True when Jira is signed in — the only way it connects. */
export function hasJiraOAuth(): boolean {
	return (
		resolveJiraOAuthApp() !== null && Boolean(readOdinConfig().jiraRefreshToken)
	);
}

export function storeJiraTokens(json: TokenResponse): string | null {
	const access = json.access_token;
	if (!access) return null;
	updateOdinConfig({
		jiraAccessToken: access,
		// Rotating refresh tokens: keep the new one, or the old if none came
		// back, because losing it means re-consenting from scratch.
		jiraRefreshToken: json.refresh_token ?? readOdinConfig().jiraRefreshToken,
		jiraTokenExpiresAt: json.expires_in
			? Date.now() + json.expires_in * 1000
			: undefined,
	});
	return access;
}

async function refreshJiraAccessToken(): Promise<string | null> {
	const app = resolveJiraOAuthApp();
	const refreshToken = readOdinConfig().jiraRefreshToken;
	if (!app || !refreshToken) return null;
	try {
		const res = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				client_id: app.clientId,
				client_secret: app.clientSecret,
				refresh_token: refreshToken,
			}),
		});
		const json = (await res.json()) as TokenResponse;
		if (!json.access_token) {
			console.error("[jira-oauth] Refresh failed:", json.error);
			return null;
		}
		return storeJiraTokens(json);
	} catch (error) {
		console.error("[jira-oauth] Refresh failed:", error);
		return null;
	}
}

/**
 * A usable access token, refreshed when it is spent or nearly so. Null when
 * Jira isn't connected.
 */
export async function jiraAccessToken(): Promise<string | null> {
	if (!hasJiraOAuth()) return null;
	const { jiraAccessToken: stored, jiraTokenExpiresAt } = readOdinConfig();
	const fresh =
		stored &&
		jiraTokenExpiresAt &&
		jiraTokenExpiresAt - REFRESH_MARGIN_MS > Date.now();
	return fresh ? (stored as string) : await refreshJiraAccessToken();
}

export interface JiraSite {
	cloudId: string;
	/** The site host. Browse links must use this, not the OAuth gateway. */
	siteUrl: string | null;
}

/**
 * The connected site, cached in config.
 *
 * OAuth request paths embed the cloudId, so this is resolved once per
 * connection rather than per call. A token that can reach several sites takes
 * the first, which is the one consent was granted for.
 */
export async function jiraSite(token: string): Promise<JiraSite | null> {
	const { jiraCloudId, jiraSiteUrl } = readOdinConfig();
	if (jiraCloudId)
		return { cloudId: jiraCloudId, siteUrl: jiraSiteUrl ?? null };
	try {
		const res = await fetch(RESOURCES_URL, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
		});
		if (!res.ok) {
			console.error("[jira-oauth] accessible-resources:", res.status);
			return null;
		}
		const resources = (await res.json()) as { id?: string; url?: string }[];
		const first = resources[0];
		if (!first?.id) return null;
		updateOdinConfig({ jiraCloudId: first.id, jiraSiteUrl: first.url });
		return { cloudId: first.id, siteUrl: first.url ?? null };
	} catch (error) {
		console.error("[jira-oauth] accessible-resources failed:", error);
		return null;
	}
}

export interface JiraRequestContext {
	/** Base for request paths: the OAuth gateway, never the site host. */
	base: string;
	authorization: string;
	/** Where a person should be sent to read the issue. */
	siteUrl: string;
}

/**
 * How to call Jira right now: Bearer through api.atlassian.com. Null when Jira
 * isn't signed in, or when the token reaches no site.
 */
export async function jiraRequestContext(): Promise<JiraRequestContext | null> {
	const token = await jiraAccessToken();
	if (!token) return null;
	const site = await jiraSite(token);
	if (!site) return null;
	return {
		base: `https://api.atlassian.com/ex/jira/${site.cloudId}`,
		authorization: `Bearer ${token}`,
		siteUrl: site.siteUrl ?? "",
	};
}
