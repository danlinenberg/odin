import {
	readOdinConfig,
	resolveNotionOAuthApp,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";

/**
 * Notion token upkeep, deliberately separate from the consent flow.
 *
 * The Notion tRPC router imports this to retry an expired access token, and
 * that router is loaded in plenty of places — so this file must stay free of
 * electron. `notion-oauth.ts` owns the browser-opening half.
 */

export interface NotionTokenResponse {
	access_token?: string;
	refresh_token?: string;
	workspace_name?: string;
	error?: string;
	error_description?: string;
}

/** Basic auth over client_id:client_secret — what Notion's token endpoint wants. */
export function notionBasicAuth(
	clientId: string,
	clientSecret: string,
): string {
	return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

/**
 * Spend the refresh token for a new access token, returning it. Null when
 * Notion isn't connected, and then the caller's original error stands.
 */
export async function refreshNotionToken(): Promise<string | null> {
	const app = resolveNotionOAuthApp();
	const refreshToken = readOdinConfig().notionRefreshToken;
	if (!app || !refreshToken) return null;
	try {
		const res = await fetch("https://api.notion.com/v1/oauth/token", {
			method: "POST",
			headers: {
				Authorization: notionBasicAuth(app.clientId, app.clientSecret),
				"Content-Type": "application/json",
				"Notion-Version": "2022-06-28",
			},
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
			}),
		});
		const json = (await res.json()) as NotionTokenResponse;
		if (!json.access_token) {
			console.error("[notion-oauth] Refresh failed:", json.error);
			return null;
		}
		updateOdinConfig({
			notionToken: json.access_token,
			// Notion returns a fresh refresh token; keep the old one if it doesn't.
			notionRefreshToken: json.refresh_token ?? refreshToken,
		});
		return json.access_token;
	} catch (error) {
		console.error("[notion-oauth] Refresh failed:", error);
		return null;
	}
}
