import { randomUUID } from "node:crypto";
import {
	readOdinConfig,
	resolveNotionOAuthApp,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";
import { type BrowserOpener, openInBrowser } from "./browser-opener";
import { type NotionTokenResponse, notionBasicAuth } from "./notion-token";

/**
 * "Connect Notion" as two clicks, on the same bounce-page pattern as Slack:
 * Notion won't redirect to a custom scheme, so its Redirect URI is a static
 * page that forwards the code into `odin://oauth/notion`, and the exchange
 * happens here in the main process where the client secret lives.
 *
 * Two differences from Slack. The consent screen is a *page picker*, so the
 * person chooses which databases Odin may read rather than pasting a database
 * id afterwards. And Notion's access tokens expire, so the refresh token is
 * stored and spent on demand — Slack's user tokens never expire, so that path
 * doesn't exist there.
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

export function isNotionOAuthConfigured(): boolean {
	return resolveNotionOAuthApp() !== null;
}

export async function startNotionOAuth(
	open: BrowserOpener = openInBrowser,
): Promise<{
	state: string;
	/** Returned so the caller can offer a "reopen" link, as GitHub's flow does. */
	authorizeUrl: string;
}> {
	const app = resolveNotionOAuthApp();
	if (!app) throw new Error("Notion OAuth is not configured");
	sweep();
	const state = randomUUID();
	pending.set(state, {
		status: "pending",
		startedAt: Date.now(),
		tokenAtStart: readOdinConfig().notionToken ?? null,
	});
	const url = new URL("https://api.notion.com/v1/oauth/authorize");
	url.searchParams.set("client_id", app.clientId);
	url.searchParams.set("response_type", "code");
	// "user" keeps the grant personal rather than installing into a workspace.
	url.searchParams.set("owner", "user");
	url.searchParams.set("redirect_uri", app.redirectUrl);
	url.searchParams.set("state", state);
	const authorizeUrl = url.toString();
	await open(authorizeUrl);
	return { state, authorizeUrl };
}

export function readNotionOAuthResult(state: string): Pending | null {
	sweep();
	const entry = pending.get(state);
	if (!entry) return null;
	// Finished in a sibling Odin, which writes the same odin.json: a token that
	// changed underneath means this succeeded elsewhere, so stop polling.
	if (
		entry.status === "pending" &&
		(readOdinConfig().notionToken ?? null) !== entry.tokenAtStart
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

export function isNotionOAuthCallback(url: string): boolean {
	return /:\/\/oauth\/notion\b/.test(url);
}

/** Handle `odin://oauth/notion?code=…&state=…`. */
export async function completeNotionOAuth(url: string): Promise<void> {
	const params = new URL(url).searchParams;
	const state = params.get("state");
	// An unknown state means we didn't start this flow: drop it rather than
	// exchanging a code someone else chose.
	if (!state || !pending.has(state)) {
		console.error("[notion-oauth] Callback with unknown or expired state");
		return;
	}
	const startedAt = pending.get(state)?.startedAt ?? Date.now();
	const fail = (error: string) => {
		console.error("[notion-oauth]", error);
		pending.set(state, { status: "failed", startedAt, error });
	};

	const denied = params.get("error");
	if (denied) return fail(denied);

	const code = params.get("code");
	if (!code) return fail("Notion callback had no code");
	const app = resolveNotionOAuthApp();
	if (!app) return fail("Notion OAuth is not configured");

	try {
		const res = await fetch("https://api.notion.com/v1/oauth/token", {
			method: "POST",
			headers: {
				Authorization: notionBasicAuth(app.clientId, app.clientSecret),
				"Content-Type": "application/json",
				"Notion-Version": "2022-06-28",
			},
			body: JSON.stringify({
				grant_type: "authorization_code",
				code,
				redirect_uri: app.redirectUrl,
			}),
		});
		const json = (await res.json()) as NotionTokenResponse;
		if (!json.access_token) {
			return fail(
				`Notion rejected the exchange: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`,
			);
		}
		updateOdinConfig({
			notionToken: json.access_token,
			notionRefreshToken: json.refresh_token,
		});
		pending.set(state, {
			status: "connected",
			startedAt,
			identity: json.workspace_name ?? null,
		});
		console.log("[notion-oauth] Connected");
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}
