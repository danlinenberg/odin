import { randomUUID } from "node:crypto";
import {
	readOdinConfig,
	resolveCalendarOAuthApp,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";
import { type BrowserOpener, openInBrowser } from "./browser-opener";
import { GOOGLE_TOKEN_URL, type GoogleTokenResponse } from "./calendar-token";

/**
 * "Sign in with Google" for Drive. It goes through the calendar's Google app
 * and its Redirect URI: the bounce page forwards every code into
 * `odin://oauth/calendar`, and the state minted here is what tells a Drive
 * callback apart (`isDriveOAuthCallback`). One app and one redirect to set up
 * in Google Cloud, not two.
 *
 * Tokens are Drive's own, so the calendar and Drive connect and disconnect
 * independently. Kept free of electron except the browser opener: the work
 * and connections routers import the token half.
 */

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Names, owners and links of files, never their contents. */
export const DRIVE_SCOPES = [
	"https://www.googleapis.com/auth/drive.metadata.readonly",
];

const PENDING_TTL_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 60_000;

type Pending =
	| { status: "pending"; startedAt: number; tokenAtStart: string | null }
	| { status: "connected"; startedAt: number }
	| { status: "failed"; startedAt: number; error: string };

const pending = new Map<string, Pending>();

function sweep(): void {
	const cutoff = Date.now() - PENDING_TTL_MS;
	for (const [state, entry] of pending)
		if (entry.startedAt < cutoff) pending.delete(state);
}

export function isDriveOAuthConfigured(): boolean {
	return resolveCalendarOAuthApp() !== null;
}

export function hasDriveOAuth(): boolean {
	return (
		isDriveOAuthConfigured() && Boolean(readOdinConfig().driveRefreshToken)
	);
}

export async function startDriveOAuth(
	open: BrowserOpener = openInBrowser,
): Promise<{ state: string; authorizeUrl: string }> {
	const app = resolveCalendarOAuthApp();
	if (!app) throw new Error("Google OAuth is not configured");
	sweep();
	const state = randomUUID();
	pending.set(state, {
		status: "pending",
		startedAt: Date.now(),
		tokenAtStart: readOdinConfig().driveRefreshToken ?? null,
	});
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("client_id", app.clientId);
	url.searchParams.set("redirect_uri", app.redirectUrl);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", DRIVE_SCOPES.join(" "));
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	url.searchParams.set("state", state);
	const authorizeUrl = url.toString();
	await open(authorizeUrl);
	return { state, authorizeUrl };
}

export function readDriveOAuthResult(state: string): Pending | null {
	sweep();
	const entry = pending.get(state);
	if (!entry) return null;
	// Finished in a sibling Odin, which writes the same odin.json.
	if (
		entry.status === "pending" &&
		(readOdinConfig().driveRefreshToken ?? null) !== entry.tokenAtStart
	) {
		const connected: Pending = {
			status: "connected",
			startedAt: entry.startedAt,
		};
		pending.set(state, connected);
		return connected;
	}
	return entry;
}

/** A callback on the shared Google redirect whose state a Drive sign-in minted. */
export function isDriveOAuthCallback(url: string): boolean {
	if (!/:\/\/oauth\/calendar\b/.test(url)) return false;
	const state = new URL(url).searchParams.get("state");
	return state !== null && pending.has(state);
}

function storeDriveTokens(json: GoogleTokenResponse): string | null {
	const access = json.access_token;
	if (!access) return null;
	updateOdinConfig({
		driveAccessToken: access,
		driveRefreshToken: json.refresh_token ?? readOdinConfig().driveRefreshToken,
		driveTokenExpiresAt: json.expires_in
			? Date.now() + json.expires_in * 1000
			: undefined,
	});
	return access;
}

/** Handle the Drive sign-in's `odin://oauth/calendar?code=…&state=…`. */
export async function completeDriveOAuth(url: string): Promise<void> {
	const params = new URL(url).searchParams;
	const state = params.get("state");
	if (!state || !pending.has(state)) {
		console.error("[drive-oauth] Callback with unknown or expired state");
		return;
	}
	const startedAt = pending.get(state)?.startedAt ?? Date.now();
	const fail = (error: string) => {
		console.error("[drive-oauth]", error);
		pending.set(state, { status: "failed", startedAt, error });
	};

	const denied = params.get("error");
	if (denied) return fail(denied);
	const code = params.get("code");
	if (!code) return fail("Google callback had no code");
	const app = resolveCalendarOAuthApp();
	if (!app) return fail("Google OAuth is not configured");

	try {
		const res = await fetch(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: app.clientId,
				client_secret: app.clientSecret,
				code,
				redirect_uri: app.redirectUrl,
			}),
		});
		const json = (await res.json()) as GoogleTokenResponse;
		if (!json.refresh_token) {
			return fail(
				json.access_token
					? "Google returned no refresh token - sign in again"
					: `Google rejected the exchange: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`,
			);
		}
		storeDriveTokens(json);
		pending.set(state, { status: "connected", startedAt });
		console.log("[drive-oauth] Connected");
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}

async function refreshDriveAccessToken(): Promise<string | null> {
	const app = resolveCalendarOAuthApp();
	const refreshToken = readOdinConfig().driveRefreshToken;
	if (!app || !refreshToken) return null;
	try {
		const res = await fetch(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: app.clientId,
				client_secret: app.clientSecret,
				refresh_token: refreshToken,
			}),
		});
		const json = (await res.json()) as GoogleTokenResponse;
		if (!json.access_token) {
			console.error("[drive-oauth] Refresh failed:", json.error);
			return null;
		}
		return storeDriveTokens(json);
	} catch (error) {
		console.error("[drive-oauth] Refresh failed:", error);
		return null;
	}
}

/** A usable access token, refreshed when spent or nearly so. Null when Drive isn't signed in. */
export async function driveAccessToken(): Promise<string | null> {
	if (!hasDriveOAuth()) return null;
	const { driveAccessToken: stored, driveTokenExpiresAt } = readOdinConfig();
	const fresh =
		stored &&
		driveTokenExpiresAt &&
		driveTokenExpiresAt - REFRESH_MARGIN_MS > Date.now();
	return fresh ? (stored as string) : await refreshDriveAccessToken();
}

/** A GET on the Drive v3 API, relative to its root. */
export function driveFetch(path: string, token: string): Promise<Response> {
	return fetch(`https://www.googleapis.com/drive/v3/${path}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
}
