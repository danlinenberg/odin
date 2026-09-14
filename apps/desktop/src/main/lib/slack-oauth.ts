import { randomUUID } from "node:crypto";
import {
	resolveSlackOAuthApp,
	resolveSlackToken,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";
import { clearSlackCaches } from "../../lib/trpc/routers/slack";
import { type BrowserOpener, openInBrowser } from "./browser-opener";

/**
 * "Connect Slack" as two clicks: open the consent screen, get a user token.
 *
 * Slack allows neither PKCE nor a non-HTTPS redirect, so a desktop app can't
 * use a loopback callback. Instead the app's Redirect URL is a static page
 * that immediately bounces the code into `odin://oauth/slack`, which
 * lands in processDeepLink → completeSlackOAuth below. The code-for-token
 * exchange then happens here, in the main process.
 *
 * The client secret therefore ships with the app. That's the accepted trade
 * for a desktop Slack app; the mitigation is that `state` is required, so a
 * stray callback can't inject a token.
 */

/** What the Reactions feed needs. Only reactions:read is load-bearing. */
const USER_SCOPES = [
	"reactions:read",
	"users:read",
	"channels:read",
	"groups:read",
	"im:read",
	"mpim:read",
];

/** A consent screen the person abandons shouldn't be resumable forever. */
const PENDING_TTL_MS = 10 * 60 * 1000;

type Pending =
	| {
			status: "pending";
			startedAt: number;
			/**
			 * The stored token when this flow began. A packaged Odin and a dev
			 * build both register `odin-odin://`, so macOS can hand the
			 * callback to the sibling app — which writes the same odin.json. A
			 * token that changed underneath therefore means "this succeeded, just
			 * not in this process", and the UI shouldn't wait forever.
			 */
			tokenAtStart: string | null;
	  }
	| { status: "connected"; startedAt: number; identity: string | null }
	| { status: "failed"; startedAt: number; error: string };

// Keyed by the `state` we generated. In memory only: a flow that doesn't
// finish before the app quits is simply restarted.
const pending = new Map<string, Pending>();

function sweep(): void {
	const cutoff = Date.now() - PENDING_TTL_MS;
	for (const [state, entry] of pending)
		if (entry.startedAt < cutoff) pending.delete(state);
}

export function isSlackOAuthConfigured(): boolean {
	return resolveSlackOAuthApp() !== null;
}

/**
 * Open Slack's consent screen in the browser. Returns the `state` to poll on
 * and the URL, for a "reopen" link; the token arrives via the deep link.
 */
export async function startSlackOAuth(
	open: BrowserOpener = openInBrowser,
): Promise<{ state: string; authorizeUrl: string }> {
	const app = resolveSlackOAuthApp();
	if (!app) throw new Error("Slack OAuth is not configured");
	sweep();
	const state = randomUUID();
	pending.set(state, {
		status: "pending",
		startedAt: Date.now(),
		tokenAtStart: resolveSlackToken(),
	});
	const url = new URL("https://slack.com/oauth/v2/authorize");
	url.searchParams.set("client_id", app.clientId);
	// Only user scopes: no bot user, so nothing has to be invited to channels.
	url.searchParams.set("user_scope", USER_SCOPES.join(","));
	url.searchParams.set("redirect_uri", app.redirectUrl);
	url.searchParams.set("state", state);
	const authorizeUrl = url.toString();
	await open(authorizeUrl);
	return { state, authorizeUrl };
}

export function readSlackOAuthResult(state: string): Pending | null {
	sweep();
	const entry = pending.get(state);
	if (!entry) return null;
	// Finished in the sibling app (see tokenAtStart): adopt the result so the
	// caller stops polling instead of hanging on a flow that actually worked.
	if (
		entry.status === "pending" &&
		resolveSlackToken() !== entry.tokenAtStart
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

/** True when this deep link is a Slack OAuth callback. */
export function isSlackOAuthCallback(url: string): boolean {
	return /:\/\/oauth\/slack\b/.test(url);
}

/**
 * Handle `odin://oauth/slack?code=…&state=…` — verify the state we
 * issued, trade the code for a user token, and store it.
 */
export async function completeSlackOAuth(url: string): Promise<void> {
	const params = new URL(url).searchParams;
	const state = params.get("state");
	// An unknown state means we didn't start this flow (or it expired): drop it
	// rather than exchanging a code an attacker chose.
	if (!state || !pending.has(state)) {
		console.error("[slack-oauth] Callback with unknown or expired state");
		return;
	}
	const startedAt = pending.get(state)?.startedAt ?? Date.now();
	const fail = (error: string) => {
		console.error("[slack-oauth]", error);
		pending.set(state, { status: "failed", startedAt, error });
	};

	// Slack reports a declined consent screen as ?error=access_denied.
	const denied = params.get("error");
	if (denied) return fail(denied);

	const code = params.get("code");
	if (!code) return fail("Slack callback had no code");

	const app = resolveSlackOAuthApp();
	if (!app) return fail("Slack OAuth is not configured");

	try {
		const res = await fetch("https://slack.com/api/oauth.v2.access", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: app.clientId,
				client_secret: app.clientSecret,
				code,
				// Slack checks this matches the authorize call.
				redirect_uri: app.redirectUrl,
			}),
		});
		const json = (await res.json()) as {
			ok?: boolean;
			error?: string;
			team?: { name?: string };
			authed_user?: { access_token?: string; token_type?: string };
		};
		if (!json.ok) return fail(`Slack rejected the exchange: ${json.error}`);
		const token = json.authed_user?.access_token;
		if (!token) {
			// A bot-only install lands here: the app requested no user scopes, so
			// there's no xoxp token and the reactions feed would stay empty.
			return fail(
				"Slack returned no user token — the app must request user scopes",
			);
		}
		updateOdinConfig({ slackToken: token });
		clearSlackCaches();
		pending.set(state, {
			status: "connected",
			startedAt,
			identity: json.team?.name ?? null,
		});
		console.log("[slack-oauth] Connected");
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}
