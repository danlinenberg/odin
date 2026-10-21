import {
	GITHUB_DEVICE_CODE_URL,
	GITHUB_DEVICE_SCOPE,
	GITHUB_TOKEN_URL,
	loginOf,
} from "../github-token";

/**
 * A GitHub sign-in of the host's own, as claude-token.ts gets Claude one:
 * the device flow run here for the host. Settings shows the code and the
 * page, the user approves once in the browser, and the pair that comes back
 * (access token, refresh token, expiry) goes to the host and nowhere else
 * (host-tokens). The host service refreshes it from then on, so a session's
 * git and gh keep working for as long as the host runs, with the laptop shut.
 *
 * Why not a copy of this computer's token: it dies after eight hours, and
 * its refresh token rotates on every use, so only one holder can refresh it.
 */

/** What the host keeps for one login, as its service reads it. */
export interface HostGithubPair {
	access_token: string;
	refresh_token?: string;
	/** Epoch seconds; absent for an OAuth app whose tokens don't expire. */
	expires_at?: number;
	/** The OAuth app the refresh goes through (not a secret). */
	client_id: string;
}

export interface HostDeviceCode {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	/** GitHub's floor is 5s; polling faster earns a slow_down. */
	intervalSeconds: number;
	expiresInSeconds: number;
}

export type HostSignInPoll =
	| { state: "pending"; intervalSeconds: number | null }
	| { state: "signed-in"; login: string; pair: HostGithubPair };

const form = (body: Record<string, string>) => ({
	method: "POST",
	headers: {
		Accept: "application/json",
		"Content-Type": "application/x-www-form-urlencoded",
	},
	body: new URLSearchParams(body),
});

/** Starts the device flow: the code to type and the page to type it on. */
export async function startHostGithubLogin(
	clientId: string,
	fetchFn: typeof fetch = fetch,
): Promise<HostDeviceCode> {
	const res = await fetchFn(
		GITHUB_DEVICE_CODE_URL,
		form({ client_id: clientId, scope: GITHUB_DEVICE_SCOPE }),
	);
	const json = (await res.json()) as {
		device_code?: string;
		user_code?: string;
		verification_uri?: string;
		interval?: number;
		expires_in?: number;
		error?: string;
		error_description?: string;
	};
	if (!json.device_code || !json.user_code || !json.verification_uri)
		throw new Error(
			`GitHub device flow: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`,
		);
	return {
		deviceCode: json.device_code,
		userCode: json.user_code,
		verificationUri: json.verification_uri,
		intervalSeconds: json.interval ?? 5,
		expiresInSeconds: json.expires_in ?? 900,
	};
}

/**
 * One poll of the device flow, on the interval GitHub asked for. Approved,
 * it answers the login the pair signs in as and the pair itself.
 */
export async function pollHostGithubLogin(
	clientId: string,
	deviceCode: string,
	fetchFn: typeof fetch = fetch,
	now: () => number = Date.now,
): Promise<HostSignInPoll> {
	const res = await fetchFn(
		GITHUB_TOKEN_URL,
		form({
			client_id: clientId,
			device_code: deviceCode,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		}),
	);
	const json = (await res.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		error?: string;
		error_description?: string;
		interval?: number;
	};
	if (json.access_token) {
		const login = await loginOf(json.access_token, fetchFn);
		if (!login)
			throw new Error("GitHub didn't say which account this is - try again.");
		return {
			state: "signed-in",
			login,
			pair: {
				access_token: json.access_token,
				...(json.refresh_token ? { refresh_token: json.refresh_token } : {}),
				...(json.expires_in
					? { expires_at: Math.floor(now() / 1000) + json.expires_in }
					: {}),
				client_id: clientId,
			},
		};
	}
	if (json.error === "authorization_pending" || json.error === "slow_down")
		return { state: "pending", intervalSeconds: json.interval ?? null };
	throw new Error(
		`GitHub device flow: ${json.error_description ?? json.error ?? "failed"}`,
	);
}
