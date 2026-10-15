import { REMOTE_CORE_PATH } from "shared/remote-core";
import { requireRemoteHostEndpoint } from "./host-client";
import { getRemoteConnectionManager } from "./remote-connection-manager";

/**
 * In remote mode a sign-in runs on the server (its state and the client
 * secret live there), but Slack/Jira/Notion bounce back to the laptop's
 * odin:// handler. Hand the callback to the server to finish. Returns false
 * outside remote mode, where the laptop completes it itself.
 */
export async function forwardOAuthCallback(url: string): Promise<boolean> {
	if (!getRemoteConnectionManager().isRemoteMode()) return false;
	const endpoint = requireRemoteHostEndpoint();
	const response = await fetch(
		`${endpoint.baseUrl}${REMOTE_CORE_PATH}/oauth.complete`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${endpoint.secret}`,
			},
			// superjson envelope, as the tRPC client sends it.
			body: JSON.stringify({ json: { url } }),
		},
	);
	if (!response.ok) {
		throw new Error(
			`The server could not finish the sign-in (HTTP ${response.status}).`,
		);
	}
	return true;
}
