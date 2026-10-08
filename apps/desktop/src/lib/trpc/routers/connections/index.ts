import { TRPCError } from "@trpc/server";
import { shell } from "electron";
import {
	githubAccessToken,
	githubApiFetch,
	rememberGithubLogin,
	storeGithubTokens,
} from "main/lib/github-token";
import {
	isJiraOAuthConfigured,
	readJiraOAuthResult,
	startJiraOAuth,
} from "main/lib/jira-oauth";
import { jiraRequestContext } from "main/lib/jira-token";
import {
	isNotionOAuthConfigured,
	readNotionOAuthResult,
	startNotionOAuth,
} from "main/lib/notion-oauth";
import { clickupFetch } from "main/lib/read-link";
import {
	isSlackOAuthConfigured,
	readSlackOAuthResult,
	startSlackOAuth,
} from "main/lib/slack-oauth";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	activeProfileId,
	createProfile,
	deleteProfile,
	listDeletedProfiles,
	listProfiles,
	readOdinConfig,
	renameProfile,
	resolveGithubClientId,
	resolveNotionToken,
	resolveSlackToken,
	restoreProfile,
	setActiveProfile,
	updateOdinConfig,
} from "../odin-config";
import { clearSlackCaches, clearSlackQueue } from "../slack";
import { fetchGmailFeed, gmailCredentials } from "../work";

/**
 * Settings → Connections: the credentials Odin's feeds run on.
 *
 * Each provider is probed with a real "who am I" call, so a row says whether
 * the token actually works - not merely that a string is present. Tokens are
 * obtained by signing in, live in this profile's slice of ~/.config/odin.json
 * and never leave the main process; the renderer only ever sees an identity
 * string.
 *
 * Signing in is the only way in. Nothing here reads a credential out of the
 * environment and nothing takes a pasted token: a shell variable is ambient
 * and would sign every profile into the same account, and a pasted token is a
 * chore that OAuth exists to remove - Gmail is the exception: its OAuth needs a
 * Google Cloud app and review, so it takes an app password, and ClickUp's
 * needs an app registered per workspace, so it takes a personal API token.
 * Slack, Jira and Notion run the browser consent flow; GitHub runs the device flow (no client secret, no
 * redirect URL, the flow GitHub built for desktop apps).
 */

const PROVIDERS = [
	"slack",
	"jira",
	"github",
	"notion",
	"gmail",
	"clickup",
] as const;
type Provider = (typeof PROVIDERS)[number];

export interface ConnectionStatus {
	provider: Provider;
	configured: boolean;
	/** Who the token authenticates as, when the probe succeeded. */
	identity: string | null;
	error: string | null;
}

/** Probes are best-effort: a network blip is an error string, not a throw. */
async function probeSlack(): Promise<ConnectionStatus> {
	const token = resolveSlackToken();
	if (!token) return unconfigured("slack");
	try {
		const res = await fetch("https://slack.com/api/auth.test", {
			headers: { Authorization: `Bearer ${token}` },
		});
		const json = (await res.json()) as {
			ok?: boolean;
			error?: string;
			user?: string;
			team?: string;
		};
		if (!json.ok) return failed("slack", json.error);
		return {
			provider: "slack",
			configured: true,
			identity: json.team ? `${json.user} · ${json.team}` : (json.user ?? null),
			error: null,
		};
	} catch (error) {
		return failed("slack", message(error));
	}
}

async function probeJira(): Promise<ConnectionStatus> {
	const oauth = await jiraRequestContext();
	if (!oauth) return unconfigured("jira");
	try {
		const res = await fetch(`${oauth.base}/rest/api/3/myself`, {
			headers: {
				Authorization: oauth.authorization,
				Accept: "application/json",
			},
		});
		if (!res.ok) return failed("jira", probeError(res.status));
		const json = (await res.json()) as { displayName?: string };
		return {
			provider: "jira",
			configured: true,
			identity: `${json.displayName ?? "connected"} · ${oauth.siteUrl.replace(/^https?:\/\//, "")}`,
			error: null,
		};
	} catch (error) {
		return failed("jira", message(error));
	}
}

async function probeGithub(): Promise<ConnectionStatus> {
	const token = await githubAccessToken();
	if (!token) return unconfigured("github");
	try {
		const res = await githubApiFetch(
			"https://api.github.com/user",
			{ headers: { Accept: "application/vnd.github+json" } },
			token,
		);
		if (!res.ok) return failed("github", probeError(res.status));
		const json = (await res.json()) as { login?: string };
		return {
			provider: "github",
			configured: true,
			identity: json.login ?? null,
			error: null,
		};
	} catch (error) {
		return failed("github", message(error));
	}
}

async function probeNotion(): Promise<ConnectionStatus> {
	const token = resolveNotionToken();
	if (!token) return unconfigured("notion");
	try {
		const res = await fetch("https://api.notion.com/v1/users/me", {
			headers: {
				Authorization: `Bearer ${token}`,
				"Notion-Version": "2022-06-28",
			},
		});
		if (!res.ok) return failed("notion", probeError(res.status));
		const json = (await res.json()) as {
			name?: string;
			bot?: {
				owner?: { user?: { name?: string; person?: { email?: string } } };
				workspace_name?: string;
			};
		};
		// The token's own name is the integration ("Odin"); show who signed in.
		const owner = json.bot?.owner?.user;
		return {
			provider: "notion",
			configured: true,
			identity:
				[owner?.name ?? owner?.person?.email, json.bot?.workspace_name]
					.filter(Boolean)
					.join(" · ") ||
				json.name ||
				"integration",
			error: null,
		};
	} catch (error) {
		return failed("notion", message(error));
	}
}

/** Gmail has no "who am I" - the feed itself is the probe, and its count the identity. */
async function probeGmail(): Promise<ConnectionStatus> {
	const credentials = gmailCredentials();
	if (!credentials) return unconfigured("gmail");
	try {
		const res = await fetchGmailFeed(credentials);
		if (!res.ok)
			return failed(
				"gmail",
				res.status === 401 ? "app password rejected" : `HTTP ${res.status}`,
			);
		const unread = (await res.text()).match(/<fullcount>(\d+)/)?.[1] ?? "?";
		return {
			provider: "gmail",
			configured: true,
			identity: `${credentials.address} · ${unread} unread`,
			error: null,
		};
	} catch (error) {
		return failed("gmail", message(error));
	}
}

async function probeClickup(): Promise<ConnectionStatus> {
	const token = readOdinConfig().clickupToken;
	if (!token) return unconfigured("clickup");
	try {
		const res = await clickupFetch("user", token);
		if (!res.ok) return failed("clickup", probeError(res.status));
		const { user } = (await res.json()) as {
			user?: { username?: string; email?: string };
		};
		return {
			provider: "clickup",
			configured: true,
			identity: user?.email ?? user?.username ?? null,
			error: null,
		};
	} catch (error) {
		return failed("clickup", message(error));
	}
}

function unconfigured(provider: Provider): ConnectionStatus {
	return { provider, configured: false, identity: null, error: null };
}

function failed(
	provider: Provider,
	error: string | undefined,
): ConnectionStatus {
	return {
		provider,
		configured: true,
		identity: null,
		error: error ?? "unknown error",
	};
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * What a failed probe should say. A 401 is not a blip to wait out: the
 * provider has thrown the credential away - revoked, expired, or signed out
 * elsewhere - and nothing but a fresh sign-in brings it back. "HTTP 401" next
 * to a Reconnect button leaves you guessing whether clicking it is the fix.
 *
 * 401 only. GitHub answers a rate limit with 403, and telling someone to sign
 * in again when they only need to wait an hour is the same mistake backwards.
 */
export function probeError(status: number): string {
	return status === 401 ? "signed out - sign in again" : `HTTP ${status}`;
}

// --- OAuth -----------------------------------------------------------------
//
// The four browser flows are identical from here: open a consent screen, get a
// `state` back, poll until the deep link lands the token. One set of
// procedures serves all of them, so a fifth provider is three lines of switch.
// (GitHub is the odd one out - device flow, below.)

const OAUTH_PROVIDERS = ["slack", "jira", "notion"] as const;
type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

const oauthInput = z.object({ provider: z.enum(OAUTH_PROVIDERS) });

function oauthConfigured(provider: OAuthProvider): boolean {
	switch (provider) {
		case "slack":
			return isSlackOAuthConfigured();
		case "jira":
			return isJiraOAuthConfigured();
		case "notion":
			return isNotionOAuthConfigured();
	}
}

function startOAuth(
	provider: OAuthProvider,
): Promise<{ state: string; authorizeUrl: string }> {
	switch (provider) {
		case "slack":
			return startSlackOAuth();
		case "jira":
			return startJiraOAuth();
		case "notion":
			return startNotionOAuth();
	}
}

function readOAuthResult(provider: OAuthProvider, state: string) {
	switch (provider) {
		case "slack":
			return readSlackOAuthResult(state);
		case "jira":
			return readJiraOAuthResult(state);
		case "notion":
			return readNotionOAuthResult(state);
	}
}

// --- GitHub device flow ----------------------------------------------------

const DEVICE_SCOPE = "repo read:org";

interface DeviceCodeResponse {
	device_code?: string;
	user_code?: string;
	verification_uri?: string;
	interval?: number;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

export const createConnectionsRouter = () => {
	return router({
		/** Every provider's live status, probed in parallel. */
		status: publicProcedure.query(async (): Promise<ConnectionStatus[]> => {
			return Promise.all([
				probeSlack(),
				probeJira(),
				probeGithub(),
				probeNotion(),
				probeGmail(),
				probeClickup(),
			]);
		}),

		/**
		 * The profiles on this machine and which one is live. Every other Odin
		 * view reads the active id from here, so a switch invalidates one query
		 * and the whole app follows.
		 */
		profiles: publicProcedure.query(() => ({
			activeId: activeProfileId(),
			profiles: listProfiles(),
			deleted: listDeletedProfiles(),
		})),

		/**
		 * Switch profiles. Slack's in-memory caches are keyed by token, but the
		 * channel and user name maps aren't - they'd hand the new workspace the
		 * old workspace's names - so they go with the switch.
		 */
		setActiveProfile: publicProcedure
			.input(z.object({ id: z.string().min(1) }))
			.mutation(({ input }) => {
				setActiveProfile(input.id);
				clearSlackCaches();
				return { activeId: activeProfileId() };
			}),

		createProfile: publicProcedure
			.input(z.object({ name: z.string().trim().min(1) }))
			.mutation(({ input }) => {
				const profile = createProfile(input.name);
				return { id: profile.id };
			}),

		renameProfile: publicProcedure
			.input(
				z.object({ id: z.string().min(1), name: z.string().trim().min(1) }),
			)
			.mutation(({ input }) => {
				renameProfile(input.id, input.name);
				return { ok: true };
			}),

		/** Deletes the profile's credentials. Refuses on the last one. */
		deleteProfile: publicProcedure
			.input(z.object({ id: z.string().min(1) }))
			.mutation(({ input }) => {
				try {
					const activeId = deleteProfile(input.id);
					clearSlackCaches();
					return { activeId };
				} catch (error) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: error instanceof Error ? error.message : String(error),
					});
				}
			}),

		/** Undo a delete from the last 30 days. */
		restoreProfile: publicProcedure
			.input(z.object({ id: z.string().min(1) }))
			.mutation(({ input }) => {
				try {
					restoreProfile(input.id);
					return { ok: true };
				} catch (error) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: error instanceof Error ? error.message : String(error),
					});
				}
			}),

		/** Whether the device flow is usable, and where its client id came from. */
		githubClientId: publicProcedure.query(() => ({
			clientId: resolveGithubClientId(),
			fromEnv: process.env.ODIN_GITHUB_CLIENT_ID !== undefined,
		})),

		/**
		 * Is this provider's sign-in available? It needs an OAuth app, which is
		 * baked into the build - a build without one says so rather than
		 * offering a button that can only fail.
		 */
		oauthConfigured: publicProcedure
			.input(oauthInput)
			.query(({ input }) => ({ configured: oauthConfigured(input.provider) })),

		/**
		 * This machine's OAuth app, for a build that wasn't compiled with one -
		 * a fresh clone run in dev. Same file the README says to edit by hand.
		 */
		saveOAuthApp: publicProcedure
			.input(
				oauthInput.extend({
					clientId: z.string().trim().min(1),
					clientSecret: z.string().trim().min(1),
					redirectUrl: z.string().trim().url(),
				}),
			)
			.mutation(({ input: { provider, ...app } }) => {
				updateOdinConfig({
					[`${provider}ClientId`]: app.clientId,
					[`${provider}ClientSecret`]: app.clientSecret,
					[`${provider}RedirectUrl`]: app.redirectUrl,
				});
				return { configured: oauthConfigured(provider) };
			}),

		/**
		 * Open the provider's consent screen in the browser. The token comes
		 * back through the deep link, into the main process, so the caller polls
		 * `oauthResult` with the state returned here rather than awaiting this.
		 */
		oauthStart: publicProcedure
			.input(oauthInput)
			.mutation(({ input }) => startOAuth(input.provider)),

		oauthResult: publicProcedure
			.input(oauthInput.extend({ state: z.string().min(1) }))
			.query(({ input }) => {
				const result = readOAuthResult(input.provider, input.state);
				// An expired or unknown state reads as pending: the UI gives up on
				// its own timeout rather than flashing an error at someone who is
				// still looking at the consent screen.
				if (!result) return { status: "pending" as const, error: null };
				return {
					status: result.status,
					error: result.status === "failed" ? result.error : null,
				};
			}),

		/** Forget a stored credential: sign-in is the only way one gets there. */
		disconnect: publicProcedure
			.input(z.object({ provider: z.enum(PROVIDERS) }))
			.mutation(({ input }) => {
				switch (input.provider) {
					case "slack":
						updateOdinConfig({ slackToken: undefined });
						clearSlackCaches();
						// The queue is stored locally, so it outlives the token unless
						// it's dropped here. The other three feeds are live reads and
						// empty themselves once the credential is gone.
						clearSlackQueue();
						break;
					case "github":
						updateOdinConfig({
							githubToken: undefined,
							githubRefreshToken: undefined,
							githubTokenExpiresAt: undefined,
							githubLogin: undefined,
						});
						break;
					case "notion":
						updateOdinConfig({
							notionToken: undefined,
							notionRefreshToken: undefined,
						});
						break;
					case "gmail":
						updateOdinConfig({
							gmailAddress: undefined,
							gmailAppPassword: undefined,
						});
						break;
					case "clickup":
						updateOdinConfig({ clickupToken: undefined });
						break;
					case "jira":
						updateOdinConfig({
							jiraAccessToken: undefined,
							jiraRefreshToken: undefined,
							jiraTokenExpiresAt: undefined,
							jiraCloudId: undefined,
							jiraSiteUrl: undefined,
						});
						break;
				}
				return { ok: true };
			}),

		/**
		 * Gmail's way in: an app password, not OAuth. Checked against the feed
		 * before it's stored, so a typo fails here rather than as a dead feed.
		 */
		saveGmail: publicProcedure
			.input(
				z.object({
					address: z.string().trim().email(),
					appPassword: z.string().trim().min(1),
				}),
			)
			.mutation(async ({ input }) => {
				const credentials = {
					address: input.address,
					password: input.appPassword.replace(/\s/g, ""),
				};
				const res = await fetchGmailFeed(credentials);
				if (!res.ok) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							res.status === 401
								? "Gmail rejected that address + app password."
								: `Gmail answered HTTP ${res.status}`,
					});
				}
				updateOdinConfig({
					gmailAddress: credentials.address,
					gmailAppPassword: credentials.password,
				});
				return { ok: true };
			}),

		/** ClickUp's way in: a personal API token, checked before it's stored. */
		saveClickup: publicProcedure
			.input(z.object({ token: z.string().trim().min(1) }))
			.mutation(async ({ input }) => {
				const res = await clickupFetch("user", input.token);
				if (!res.ok) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							res.status === 401
								? "ClickUp rejected that token."
								: `ClickUp answered HTTP ${res.status}`,
					});
				}
				updateOdinConfig({ clickupToken: input.token });
				return { ok: true };
			}),

		/** Save the OAuth app client id the device flow runs against. */
		saveGithubClientId: publicProcedure
			.input(z.object({ clientId: z.string().min(1) }))
			.mutation(({ input }) => {
				updateOdinConfig({ githubClientId: input.clientId.trim() });
				return { ok: true };
			}),

		/**
		 * Start GitHub's device flow: returns the code to type, and opens the
		 * verification page in the browser.
		 */
		githubDeviceStart: publicProcedure.mutation(async () => {
			const clientId = resolveGithubClientId();
			if (!clientId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"No GitHub client id - create an OAuth app with device flow enabled and paste its client id here.",
				});
			}
			const res = await fetch("https://github.com/login/device/code", {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({ client_id: clientId, scope: DEVICE_SCOPE }),
			});
			const json = (await res.json()) as DeviceCodeResponse;
			if (!json.device_code || !json.user_code || !json.verification_uri) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `GitHub device flow: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`,
				});
			}
			await shell.openExternal(json.verification_uri);
			return {
				deviceCode: json.device_code,
				userCode: json.user_code,
				verificationUri: json.verification_uri,
				// GitHub's floor is 5s; polling faster earns a slow_down.
				intervalSeconds: json.interval ?? 5,
				expiresInSeconds: json.expires_in ?? 900,
			};
		}),

		/**
		 * One poll of the device flow. The renderer calls this on the interval
		 * GitHub asked for until it stops returning "pending".
		 */
		githubDevicePoll: publicProcedure
			.input(z.object({ deviceCode: z.string().min(1) }))
			.mutation(async ({ input }) => {
				const clientId = resolveGithubClientId();
				if (!clientId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "No GitHub client id configured.",
					});
				}
				const res = await fetch("https://github.com/login/oauth/access_token", {
					method: "POST",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams({
						client_id: clientId,
						device_code: input.deviceCode,
						grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					}),
				});
				const json = (await res.json()) as {
					access_token?: string;
					refresh_token?: string;
					expires_in?: number;
					error?: string;
					error_description?: string;
					interval?: number;
				};
				if (json.access_token) {
					// Keeps the refresh token when the app issues one: without it
					// the connection dies eight hours later, for good.
					storeGithubTokens(json);
					await rememberGithubLogin(json.access_token);
					return { state: "connected" as const };
				}
				if (
					json.error === "authorization_pending" ||
					json.error === "slow_down"
				) {
					return {
						state: "pending" as const,
						// slow_down carries a new, longer interval - honour it.
						intervalSeconds: json.interval ?? null,
					};
				}
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `GitHub device flow: ${json.error_description ?? json.error ?? "failed"}`,
				});
			}),

		/** Where the file-backed credentials live, for the "edit by hand" case. */
		configPath: publicProcedure.query(() => ({
			path: process.env.ODIN_CONFIG_PATH ?? "~/.config/odin.json",
			hasFileConfig: Object.keys(readOdinConfig()).length > 0,
		})),
	});
};
