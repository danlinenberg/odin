import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	readOdinConfig,
	resolveGithubClientId,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";

/**
 * GitHub token upkeep, alongside Jira's and Google's and for the same reason:
 * the work router spends the token and that router is loaded in plenty of
 * places, so this file stays free of electron.
 *
 * An OAuth app with "expiring user authorization tokens" turned on hands the
 * device flow a token that dies after eight hours, plus a refresh token good
 * for six months. Without the refresh, GitHub's panes go red twice a day and
 * the only cure is signing in again — which is exactly what was happening.
 *
 * Refreshing needs no client secret when the token came from the device flow,
 * which is the whole reason a desktop app can do this at all. The refresh
 * token rotates on every use, so the new pair must replace the old one.
 *
 * An app *without* expiring tokens sends neither field; then there is nothing
 * to refresh and the stored token is used until someone revokes it.
 *
 * And they do get revoked — server-side, with no expiry, no audit-log entry and
 * no mail, every day or two. `githubApiFetch` is the answer to that: the `gh`
 * CLI keeps a working token for the same account, so a revoked token costs a
 * pane refresh instead of a trip to Settings.
 */

const run = promisify(execFile);

const TOKEN_URL = "https://github.com/login/oauth/access_token";

/** Refresh this far before expiry, so a call in flight doesn't age out. */
const REFRESH_MARGIN_MS = 60_000;

export interface GithubTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

/**
 * Persist what the device flow or a refresh handed back. Returns the access
 * token, or null when the response carried none.
 */
export function storeGithubTokens(json: GithubTokenResponse): string | null {
	const access = json.access_token;
	if (!access) return null;
	updateOdinConfig({
		githubToken: access,
		// Rotating refresh tokens: keep the new one, or the old if none came
		// back, because losing it means signing in from scratch.
		githubRefreshToken:
			json.refresh_token ?? readOdinConfig().githubRefreshToken,
		githubTokenExpiresAt: json.expires_in
			? Date.now() + json.expires_in * 1000
			: undefined,
	});
	return access;
}

async function refreshGithubAccessToken(): Promise<string | null> {
	const clientId = resolveGithubClientId();
	const refreshToken = readOdinConfig().githubRefreshToken;
	if (!clientId || !refreshToken) return null;
	try {
		const res = await fetch(TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			// No client_secret: GitHub waives it for device-flow tokens.
			body: new URLSearchParams({
				client_id: clientId,
				grant_type: "refresh_token",
				refresh_token: refreshToken,
			}),
		});
		const json = (await res.json()) as GithubTokenResponse;
		if (!json.access_token) {
			console.error("[github-oauth] Refresh failed:", json.error);
			return null;
		}
		return storeGithubTokens(json);
	} catch (error) {
		console.error("[github-oauth] Refresh failed:", error);
		return null;
	}
}

/**
 * A usable access token, refreshed when it is spent or nearly so. Null when
 * GitHub isn't connected at all.
 *
 * A failed refresh falls back to the stored token rather than reporting "not
 * connected": the request then comes back 401 and the pane says reconnect,
 * which is the true state of things when the refresh token is dead too.
 */
export async function githubAccessToken(): Promise<string | null> {
	const { githubToken, githubTokenExpiresAt } = readOdinConfig();
	if (!githubToken) return null;
	if (
		!githubTokenExpiresAt ||
		githubTokenExpiresAt - REFRESH_MARGIN_MS > Date.now()
	) {
		return githubToken;
	}
	return (await refreshGithubAccessToken()) ?? githubToken;
}

/**
 * The token `gh` holds for the account Odin is connected as. Pinned to that
 * login, because `gh auth token` alone answers for whichever account is
 * *active* — on a machine signed into a work and a personal account that is a
 * coin flip, and the wrong one quietly returns somebody else's pull requests.
 */
export async function githubCliToken(): Promise<string | null> {
	const login = readOdinConfig().githubLogin;
	if (!login) return null;
	try {
		const { stdout } = await run("gh", ["auth", "token", "--user", login], {
			timeout: 5_000,
		});
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

let revokedToken: string | null = null;

/**
 * Call GitHub with `token`, retrying once with the `gh` CLI's token when
 * GitHub rejects it. 401 only: a 403 is a rate limit or a scope problem, and
 * the CLI token would hit exactly the same wall.
 */
export async function githubApiFetch(
	url: string,
	init: RequestInit,
	token: string,
): Promise<Response> {
	const send = (bearer: string) =>
		fetch(url, {
			...init,
			headers: { ...init.headers, Authorization: `Bearer ${bearer}` },
		});
	const res = token === revokedToken ? null : await send(token);
	if (res && res.status !== 401) return res;
	const cli = await githubCliToken();
	if (cli && cli !== token) {
		revokedToken = token;
		return await send(cli);
	}
	return res ?? (await send(token));
}

/**
 * Cache who the token belongs to, so the CLI fallback can ask for that same
 * account later. Called once per sign-in; a failure is not fatal, it only
 * costs the fallback.
 */
export async function rememberGithubLogin(token: string): Promise<void> {
	try {
		const res = await fetch("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
			},
		});
		if (!res.ok) return;
		const { login } = (await res.json()) as { login?: string };
		if (login) updateOdinConfig({ githubLogin: login });
	} catch (error) {
		console.error("[github-oauth] Could not read the account login:", error);
	}
}
