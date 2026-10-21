import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	type GithubAccount,
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
 * the only cure is signing in again - which is exactly what was happening.
 *
 * Refreshing needs no client secret when the token came from the device flow,
 * which is the whole reason a desktop app can do this at all. The refresh
 * token rotates on every use, so the new pair must replace the old one.
 *
 * An app *without* expiring tokens sends neither field; then there is nothing
 * to refresh and the stored token is used until someone revokes it.
 *
 * And they do get revoked - server-side, with no expiry, no audit-log entry and
 * no mail, every day or two. `githubApiFetch` is the answer to that: the `gh`
 * CLI keeps a working token for the same account, so a revoked token costs a
 * pane refresh instead of a trip to Settings.
 */

const run = promisify(execFile);

export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
/** What the device flow asks for: repos, and the orgs they belong to. */
export const GITHUB_DEVICE_SCOPE = "repo read:org";

/** Refresh this far before expiry, so a call in flight doesn't age out. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Who wants to know when a token here changes: the remote host, which keeps
 * a copy of this computer's tokens for sessions there (host-tokens), and
 * would otherwise hold one that died at the eight-hour mark.
 */
const changeListeners = new Set<() => void>();
export function onGithubTokensChanged(listener: () => void): () => void {
	changeListeners.add(listener);
	return () => changeListeners.delete(listener);
}
function tokensChanged(): void {
	for (const listener of changeListeners) listener();
}

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
	tokensChanged();
	return access;
}

/** One refresh-token exchange; null when GitHub hands back no token. */
async function exchangeRefreshToken(
	refreshToken: string | undefined,
): Promise<GithubTokenResponse | null> {
	const clientId = resolveGithubClientId();
	if (!clientId || !refreshToken) return null;
	try {
		const res = await fetch(GITHUB_TOKEN_URL, {
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
		return json;
	} catch (error) {
		console.error("[github-oauth] Refresh failed:", error);
		return null;
	}
}

async function refreshGithubAccessToken(): Promise<string | null> {
	const json = await exchangeRefreshToken(readOdinConfig().githubRefreshToken);
	return json ? storeGithubTokens(json) : null;
}

function needsRefresh(
	expiresAt: number | undefined,
	margin = REFRESH_MARGIN_MS,
): boolean {
	return !!expiresAt && expiresAt - margin <= Date.now();
}

/**
 * A usable access token, refreshed when it is spent or nearly so. Null when
 * GitHub isn't connected at all. `margin` asks for one good for at least that
 * long: a copy sent to the remote host must outlive the gap to the next copy.
 *
 * A failed refresh falls back to the stored token rather than reporting "not
 * connected": the request then comes back 401 and the pane says reconnect,
 * which is the true state of things when the refresh token is dead too.
 */
export async function githubAccessToken(
	margin = REFRESH_MARGIN_MS,
): Promise<string | null> {
	const { githubToken, githubTokenExpiresAt } = readOdinConfig();
	if (!githubToken) return null;
	if (!needsRefresh(githubTokenExpiresAt, margin)) return githubToken;
	return (await refreshGithubAccessToken()) ?? githubToken;
}

/** The connections beside the main one, by login. */
export function extraGithubAccounts(): GithubAccount[] {
	return readOdinConfig().githubAccounts ?? [];
}

function saveExtraAccount(account: GithubAccount): void {
	const others = extraGithubAccounts().filter((a) => a.login !== account.login);
	updateOdinConfig({ githubAccounts: [...others, account] });
	tokensChanged();
}

/** An extra account's token, refreshed (and saved) the same way as the main one's. */
async function extraAccountToken(
	account: GithubAccount,
	margin = REFRESH_MARGIN_MS,
): Promise<string> {
	if (!needsRefresh(account.expiresAt, margin)) return account.token;
	const json = await exchangeRefreshToken(account.refreshToken);
	if (!json?.access_token) return account.token;
	saveExtraAccount({
		login: account.login,
		token: json.access_token,
		refreshToken: json.refresh_token ?? account.refreshToken,
		expiresAt: json.expires_in
			? Date.now() + json.expires_in * 1000
			: undefined,
	});
	return json.access_token;
}

/**
 * One connected account's usable token, by login: the main connection's or an
 * extra one's, refreshed the same way. Null for a login that isn't connected.
 */
export async function githubTokenForLogin(
	login: string,
	margin = REFRESH_MARGIN_MS,
): Promise<string | null> {
	const main = readOdinConfig().githubLogin;
	if (main && main.toLowerCase() === login.toLowerCase())
		return githubAccessToken(margin);
	const account = extraGithubAccounts().find(
		(a) => a.login.toLowerCase() === login.toLowerCase(),
	);
	return account ? extraAccountToken(account, margin) : null;
}

export interface GithubAccountToken {
	/** Null for a main connection made before the login was cached. */
	login: string | null;
	token: string;
}

/** Every connected account's usable token, the main connection first. */
export async function githubAccountTokens(): Promise<GithubAccountToken[]> {
	const out: GithubAccountToken[] = [];
	const main = await githubAccessToken();
	if (main)
		out.push({ login: readOdinConfig().githubLogin ?? null, token: main });
	for (const account of extraGithubAccounts()) {
		out.push({ login: account.login, token: await extraAccountToken(account) });
	}
	return out;
}

/** Who a token signs in as, or null when GitHub won't say. */
export async function loginOf(
	token: string,
	fetchFn: typeof fetch = fetch,
): Promise<string | null> {
	try {
		const res = await fetchFn("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
			},
		});
		if (!res.ok) return null;
		return ((await res.json()) as { login?: string }).login ?? null;
	} catch {
		return null;
	}
}

/**
 * Save a finished device flow. `add` keeps the existing connection and adds
 * this one beside it; signing in again as an account already connected just
 * replaces its token. With no main connection yet, this becomes the main one.
 */
export async function connectGithubAccount(
	json: GithubTokenResponse,
	add: boolean,
): Promise<void> {
	const token = json.access_token;
	if (!token) return;
	const login = await loginOf(token);
	const { githubToken, githubLogin } = readOdinConfig();
	if (!add || !githubToken || (login && login === githubLogin)) {
		storeGithubTokens(json);
		if (login) updateOdinConfig({ githubLogin: login });
		return;
	}
	if (!login)
		throw new Error("GitHub didn't say which account this is - try again.");
	saveExtraAccount({
		login,
		token,
		refreshToken: json.refresh_token,
		expiresAt: json.expires_in
			? Date.now() + json.expires_in * 1000
			: undefined,
	});
}

/**
 * Forget one account. Removing the main connection promotes the next account,
 * so the other connections keep working.
 */
export function disconnectGithubAccount(login?: string): void {
	const extras = extraGithubAccounts();
	if (login && login !== readOdinConfig().githubLogin) {
		updateOdinConfig({
			githubAccounts: extras.filter((a) => a.login !== login),
		});
		tokensChanged();
		return;
	}
	const [next, ...rest] = extras;
	updateOdinConfig({
		githubToken: next?.token,
		githubRefreshToken: next?.refreshToken,
		githubTokenExpiresAt: next?.expiresAt,
		githubLogin: next?.login,
		githubAccounts: rest.length ? rest : undefined,
	});
	tokensChanged();
}

/**
 * The token `gh` holds for the account Odin is connected as. Pinned to that
 * login, because `gh auth token` alone answers for whichever account is
 * *active* - on a machine signed into a work and a personal account that is a
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

/** The repo owner a GitHub URL is about - `api.github.com/repos/<owner>/…` or `github.com/<owner>/…`. */
export function githubOwner(url: string): string | null {
	const m =
		/^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([\w.-]+)\//i.exec(
			url,
		);
	return m ? m[1].toLowerCase() : null;
}

/** Which account last worked for each repo owner, so it goes first next time. */
const accountByOwner = new Map<string, string>();

/**
 * The order to try tokens in for `url`: the account that last worked for its
 * owner, then the caller's token, then every other connected account. A
 * private repo another account can't see answers 404, not 403, so 404 moves on
 * to the next account too.
 */
export function tokenOrder(
	url: string,
	token: string,
	accounts: GithubAccountToken[],
	remembered: ReadonlyMap<string, string> = accountByOwner,
): GithubAccountToken[] {
	const owner = githubOwner(url);
	const first = owner ? remembered.get(owner) : undefined;
	const caller = accounts.find((a) => a.token === token) ?? {
		login: null,
		token,
	};
	const ordered = [
		...accounts.filter((a) => first && a.login === first),
		caller,
		...accounts,
	];
	return ordered.filter(
		(a, i) => ordered.findIndex((b) => b.token === a.token) === i,
	);
}

/**
 * Call GitHub with `token`, then with the other connected accounts when it is
 * rejected (401) or can't see the repo (404), then once with the `gh` CLI's
 * token. A 403 is a rate limit or a scope problem: another token would hit
 * the same wall, so it is returned as is.
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
	const owner = githubOwner(url);
	let res: Response | null = null;
	for (const account of tokenOrder(url, token, await githubAccountTokens())) {
		if (account.token === revokedToken) continue;
		res = await send(account.token);
		if (res.status !== 401 && res.status !== 404) {
			if (owner && account.login) accountByOwner.set(owner, account.login);
			return res;
		}
		if (res.status === 401 && account.token === token) revokedToken = token;
	}
	if (res && res.status !== 401) return res;
	const cli = await githubCliToken();
	if (cli && cli !== token) return await send(cli);
	return res ?? (await send(token));
}
