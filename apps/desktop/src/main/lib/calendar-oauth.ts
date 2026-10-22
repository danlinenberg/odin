import { randomUUID } from "node:crypto";
import {
	readOdinConfig,
	resolveCalendarOAuthApp,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";
import { type BrowserOpener, openInBrowser } from "./browser-opener";
import { primaryCalendarId } from "./calendar";
import {
	GOOGLE_TOKEN_URL,
	type GoogleTokenResponse,
	storeCalendarTokens,
} from "./calendar-token";

/**
 * "Sign in with Google" for the Calendar, on the same bounce-page pattern as
 * Slack, Notion and Jira: the Redirect URI is a static page that forwards the
 * code into `odin://oauth/calendar`, and the exchange happens here where the
 * client secret lives.
 *
 * `access_type=offline` is what makes a refresh token come back, and
 * `prompt=consent` makes Google send one again on a re-connect - without it a
 * second sign-in returns only an hour's access token.
 */

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Read-only: list events, and name the primary calendar for Settings. */
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

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

export function isCalendarOAuthConfigured(): boolean {
	return resolveCalendarOAuthApp() !== null;
}

export async function startCalendarOAuth(
	open: BrowserOpener = openInBrowser,
): Promise<{ state: string; authorizeUrl: string }> {
	const app = resolveCalendarOAuthApp();
	if (!app) throw new Error("Google Calendar OAuth is not configured");
	sweep();
	const state = randomUUID();
	pending.set(state, {
		status: "pending",
		startedAt: Date.now(),
		tokenAtStart: readOdinConfig().calendarRefreshToken ?? null,
	});
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("client_id", app.clientId);
	url.searchParams.set("redirect_uri", app.redirectUrl);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", SCOPES.join(" "));
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	url.searchParams.set("state", state);
	const authorizeUrl = url.toString();
	await open(authorizeUrl);
	return { state, authorizeUrl };
}

export function readCalendarOAuthResult(state: string): Pending | null {
	sweep();
	const entry = pending.get(state);
	if (!entry) return null;
	// Finished in a sibling Odin, which writes the same odin.json.
	if (
		entry.status === "pending" &&
		(readOdinConfig().calendarRefreshToken ?? null) !== entry.tokenAtStart
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

export function isCalendarOAuthCallback(url: string): boolean {
	return /:\/\/oauth\/calendar\b/.test(url);
}

/** Handle `odin://oauth/calendar?code=…&state=…`. */
export async function completeCalendarOAuth(url: string): Promise<void> {
	const params = new URL(url).searchParams;
	const state = params.get("state");
	if (!state || !pending.has(state)) {
		console.error("[calendar-oauth] Callback with unknown or expired state");
		return;
	}
	const startedAt = pending.get(state)?.startedAt ?? Date.now();
	const fail = (error: string) => {
		console.error("[calendar-oauth]", error);
		pending.set(state, { status: "failed", startedAt, error });
	};

	const denied = params.get("error");
	if (denied) return fail(denied);
	const code = params.get("code");
	if (!code) return fail("Google callback had no code");
	const app = resolveCalendarOAuthApp();
	if (!app) return fail("Google Calendar OAuth is not configured");

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
			// No refresh token means the connection dies within the hour.
			return fail(
				json.access_token
					? "Google returned no refresh token - sign in again"
					: `Google rejected the exchange: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`,
			);
		}
		const access = storeCalendarTokens(json);
		// Signed in to Google now, so the pasted address is no longer read.
		updateOdinConfig({ calendarUrl: undefined });
		pending.set(state, {
			status: "connected",
			startedAt,
			identity: access ? await primaryCalendarId(access) : null,
		});
		console.log("[calendar-oauth] Connected");
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}
