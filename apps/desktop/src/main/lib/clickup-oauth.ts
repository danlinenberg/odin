import { randomUUID } from "node:crypto";
import {
	readOdinConfig,
	resolveClickupOAuthApp,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";
import { type BrowserOpener, openInBrowser } from "./browser-opener";
import { clickupFetch } from "./read-link";

/**
 * "Connect ClickUp" as two clicks, on the Notion bounce-page pattern: the
 * Redirect URI is a static page that forwards the code into
 * `odin://oauth/clickup`, and the exchange happens here in the main process
 * where the client secret lives. ClickUp's tokens don't expire, so there is
 * no refresh path. A build without the app falls back to a pasted token.
 */

/** A consent screen the person abandons shouldn't be resumable forever. */
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

export function isClickupOAuthConfigured(): boolean {
	return resolveClickupOAuthApp() !== null;
}

export async function startClickupOAuth(
	open: BrowserOpener = openInBrowser,
): Promise<{ state: string; authorizeUrl: string }> {
	const app = resolveClickupOAuthApp();
	if (!app) throw new Error("ClickUp OAuth is not configured");
	sweep();
	const state = randomUUID();
	pending.set(state, {
		status: "pending",
		startedAt: Date.now(),
		tokenAtStart: readOdinConfig().clickupToken ?? null,
	});
	const url = new URL("https://app.clickup.com/api");
	url.searchParams.set("client_id", app.clientId);
	url.searchParams.set("redirect_uri", app.redirectUrl);
	url.searchParams.set("state", state);
	const authorizeUrl = url.toString();
	await open(authorizeUrl);
	return { state, authorizeUrl };
}

export function readClickupOAuthResult(state: string): Pending | null {
	sweep();
	const entry = pending.get(state);
	if (!entry) return null;
	// Finished in a sibling Odin, which writes the same odin.json.
	if (
		entry.status === "pending" &&
		(readOdinConfig().clickupToken ?? null) !== entry.tokenAtStart
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

export function isClickupOAuthCallback(url: string): boolean {
	return /:\/\/oauth\/clickup\b/.test(url);
}

/** Handle `odin://oauth/clickup?code=…&state=…`. */
export async function completeClickupOAuth(url: string): Promise<void> {
	const params = new URL(url).searchParams;
	const state = params.get("state");
	// An unknown state means we didn't start this flow: drop it rather than
	// exchanging a code someone else chose.
	if (!state || !pending.has(state)) {
		console.error("[clickup-oauth] Callback with unknown or expired state");
		return;
	}
	const startedAt = pending.get(state)?.startedAt ?? Date.now();
	const fail = (error: string) => {
		console.error("[clickup-oauth]", error);
		pending.set(state, { status: "failed", startedAt, error });
	};

	const denied = params.get("error");
	if (denied) return fail(denied);
	const code = params.get("code");
	if (!code) return fail("ClickUp callback had no code");
	const app = resolveClickupOAuthApp();
	if (!app) return fail("ClickUp OAuth is not configured");

	try {
		const token = new URL("https://api.clickup.com/api/v2/oauth/token");
		token.searchParams.set("client_id", app.clientId);
		token.searchParams.set("client_secret", app.clientSecret);
		token.searchParams.set("code", code);
		const res = await fetch(token, { method: "POST" });
		const json = (await res.json()) as { access_token?: string; err?: string };
		if (!json.access_token) {
			return fail(
				`ClickUp rejected the exchange: ${json.err ?? `HTTP ${res.status}`}`,
			);
		}
		const me = await clickupFetch("user", json.access_token);
		const user = me.ok
			? ((await me.json()) as { user?: { username?: string; email?: string } })
					.user
			: undefined;
		updateOdinConfig({ clickupToken: json.access_token });
		pending.set(state, {
			status: "connected",
			startedAt,
			identity: user?.username ?? user?.email ?? null,
		});
		console.log("[clickup-oauth] Connected");
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}
