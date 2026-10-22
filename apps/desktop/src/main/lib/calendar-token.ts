import {
	readOdinConfig,
	resolveCalendarOAuthApp,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";

/**
 * Google Calendar token upkeep, deliberately separate from the consent flow.
 *
 * Google's access tokens last an hour and its refresh tokens don't rotate: a
 * refresh hands back a new access token and usually no refresh token, so the
 * stored one is kept. Kept free of electron, like `jira-token.ts`: the work
 * and connections routers import this.
 */

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Refresh this far before expiry, so a call in flight doesn't age out. */
const REFRESH_MARGIN_MS = 60_000;

export interface GoogleTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

/** True when the calendar is signed in to Google, not read from an iCal address. */
export function hasCalendarOAuth(): boolean {
	return (
		resolveCalendarOAuthApp() !== null &&
		Boolean(readOdinConfig().calendarRefreshToken)
	);
}

export function storeCalendarTokens(json: GoogleTokenResponse): string | null {
	const access = json.access_token;
	if (!access) return null;
	updateOdinConfig({
		calendarAccessToken: access,
		calendarRefreshToken:
			json.refresh_token ?? readOdinConfig().calendarRefreshToken,
		calendarTokenExpiresAt: json.expires_in
			? Date.now() + json.expires_in * 1000
			: undefined,
	});
	return access;
}

async function refreshCalendarAccessToken(): Promise<string | null> {
	const app = resolveCalendarOAuthApp();
	const refreshToken = readOdinConfig().calendarRefreshToken;
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
			console.error("[calendar-oauth] Refresh failed:", json.error);
			return null;
		}
		return storeCalendarTokens(json);
	} catch (error) {
		console.error("[calendar-oauth] Refresh failed:", error);
		return null;
	}
}

/**
 * A usable access token, refreshed when it is spent or nearly so. Null when
 * the calendar isn't signed in to Google.
 */
export async function calendarAccessToken(): Promise<string | null> {
	if (!hasCalendarOAuth()) return null;
	const { calendarAccessToken: stored, calendarTokenExpiresAt } =
		readOdinConfig();
	const fresh =
		stored &&
		calendarTokenExpiresAt &&
		calendarTokenExpiresAt - REFRESH_MARGIN_MS > Date.now();
	return fresh ? (stored as string) : await refreshCalendarAccessToken();
}
