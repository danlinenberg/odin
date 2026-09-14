import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_PROFILE_ID } from "shared/odin-profile";

/**
 * Odin's own config file — `~/.config/odin.json`.
 *
 * Every Odin feed (Notion tasks, Jira, GitHub, Slack) reads its credentials
 * from this file, and every one of them is an OAuth token Settings →
 * Connections wrote after a sign-in. Nothing here is pasted or exported from a
 * shell — a packaged app launched from Finder has no shell env anyway.
 *
 * The file holds one bundle of credentials **per profile** — work and personal
 * are different Slack workspaces, different Jiras, different GitHub accounts —
 * and everything else in Odin that is account-shaped (the Slack queue, board
 * sessions, my tasks) is scoped by the same profile id.
 *
 * Main process only: the tokens must never reach the renderer.
 */

export interface OdinFileConfig {
	/** Notion OAuth access token. */
	notionToken?: string;
	/** Notion database the Tasks view lists rows from (picked in that view). */
	notionTaskDbId?: string;
	/** Legacy name for the same thing — still read, never written. */
	slackQueueDbId?: string;
	defaultRepo?: string;

	/**
	 * Jira OAuth (Atlassian 3LO). These tokens expire and the refresh token
	 * rotates on every use, so the current pair and the expiry are all stored.
	 * cloudId identifies the site: OAuth calls go to
	 * api.atlassian.com/ex/jira/{cloudId}, never to the site host.
	 */
	jiraClientId?: string;
	jiraClientSecret?: string;
	jiraRedirectUrl?: string;
	jiraAccessToken?: string;
	jiraRefreshToken?: string;
	jiraTokenExpiresAt?: number;
	jiraCloudId?: string;
	/** Site host, for browse links — request paths use cloudId instead. */
	jiraSiteUrl?: string;

	githubToken?: string;
	/**
	 * An OAuth app with expiring tokens enabled issues an eight-hour access
	 * token and a rotating refresh token; one without them sends neither, and
	 * then `githubToken` alone is the whole story. See `main/lib/github-token`.
	 */
	githubRefreshToken?: string;
	githubTokenExpiresAt?: number;
	/**
	 * Which GitHub account the token belongs to. Cached at sign-in so the `gh`
	 * CLI fallback in `main/lib/github-token` can ask for that same account.
	 */
	githubLogin?: string;
	/** OAuth app client id used for GitHub's device flow (not a secret). */
	githubClientId?: string;

	/** Slack **user** token (`xoxp-…`) — bot tokens can't read my reactions. */
	slackToken?: string;
	/** Reaction that queues a message — a Slack name, no colons. Default `eyes`. */
	slackReaction?: string;
	/**
	 * Slack OAuth app, so people can connect with a click instead of minting a
	 * token by hand. Slack has no PKCE and refuses non-HTTPS redirects, so the
	 * secret lives here and the redirect points at a static page that bounces
	 * the code back into the app (see docs/oauth/README.md).
	 */
	slackClientId?: string;
	slackClientSecret?: string;
	slackRedirectUrl?: string;

	/**
	 * Notion OAuth connection. Unlike Slack, Notion hands back a refresh token
	 * and its access tokens expire, so both are stored.
	 */
	notionClientId?: string;
	notionClientSecret?: string;
	notionRedirectUrl?: string;
	notionRefreshToken?: string;

	/** Checkout Odin rebuilds itself from. */
	odinRepo?: string;
}

/** Override exists so tests can point at a temp file instead of $HOME. */
function configPath(): string {
	return process.env.ODIN_CONFIG_PATH ?? join(homedir(), ".config/odin.json");
}

// ---------------------------------------------------------------------------
// Profiles
//
// A profile is one set of accounts: its own Slack, Jira, GitHub and Notion.
// The id is what the rest of the app stamps on the things a profile owns —
// Slack queue rows, board sessions, my tasks — so it must be stable once
// written. The profile the flat pre-profiles file becomes keeps the literal id
// `default`, which is also what an unstamped row is read as.
// ---------------------------------------------------------------------------

export { DEFAULT_PROFILE_ID };

export interface OdinProfile {
	id: string;
	name: string;
	config: OdinFileConfig;
}

/**
 * Keys that describe this machine rather than an account, and so stay at the
 * top level and are shared by every profile. `odinRepo` is the checkout Odin
 * rebuilds itself from — a new profile that lost it would break Update Odin.
 */
const SHARED_KEYS = [
	"odinRepo",
	// The OAuth apps: which Slack/Jira/Notion app Odin *is*, and
	// GitHub's device-flow client id. They describe the build, not an account,
	// so every profile signs in through the same one — a profile that didn't
	// have them would offer no way to sign in at all.
	"slackClientId",
	"slackClientSecret",
	"slackRedirectUrl",
	"jiraClientId",
	"jiraClientSecret",
	"jiraRedirectUrl",
	"notionClientId",
	"notionClientSecret",
	"notionRedirectUrl",
	"githubClientId",
] as const;

interface RootConfig {
	activeProfileId: string;
	profiles: OdinProfile[];
	shared: OdinFileConfig;
}

/**
 * The file, normalised. A pre-profiles file (credentials at the top level) is
 * read as the single `default` profile; it's rewritten in that shape by the
 * next write, so there is no separate migration step to run or to fail.
 */
function readRoot(): RootConfig {
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(readFileSync(configPath(), "utf-8")) as Record<
			string,
			unknown
		>;
	} catch {
		raw = {};
	}

	const shared: OdinFileConfig = {};
	for (const key of SHARED_KEYS) {
		const value = raw[key];
		if (value !== undefined) shared[key] = value as string;
	}

	let profiles = Array.isArray(raw.profiles)
		? (raw.profiles as OdinProfile[]).filter((p) => p?.id && p?.name)
		: null;
	if (!profiles) {
		const { profiles: _p, activeProfileId: _a, ...flat } = raw;
		for (const key of SHARED_KEYS) delete flat[key];
		profiles = [
			{
				id: DEFAULT_PROFILE_ID,
				name: "Default",
				config: flat as OdinFileConfig,
			},
		];
	}
	if (profiles.length === 0) {
		profiles = [{ id: DEFAULT_PROFILE_ID, name: "Default", config: {} }];
	}

	// Files written before the apps became shared keep them inside a profile;
	// hoist them, or every other profile comes up with nothing to sign in
	// with. ponytail: the copy is left in the profile — harmless, since the
	// values are identical and the active profile's copy wins either way.
	for (const key of SHARED_KEYS) {
		if (shared[key] !== undefined) continue;
		const owner = profiles.find((p) => p.config?.[key] !== undefined);
		if (owner) shared[key] = owner.config[key];
	}

	// Jira's old API-token trio, from before sign-in existed. Dropped on read,
	// so a live token stops being handed out now and leaves the file on the
	// next write. ponytail: no migration step — there is nothing to migrate to,
	// Jira reconnects through OAuth.
	for (const profile of profiles) {
		for (const key of ["jiraBaseUrl", "jiraEmail", "jiraToken"]) {
			delete (profile.config as Record<string, unknown>)?.[key];
		}
	}

	// An active id naming a profile that no longer exists falls back to the
	// first one — never to "no profile", which would read as "nothing connected".
	const wanted = raw.activeProfileId;
	const activeProfileId = profiles.some((p) => p.id === wanted)
		? (wanted as string)
		: profiles[0].id;

	return { activeProfileId, profiles, shared };
}

function writeRoot(root: RootConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	const body = {
		activeProfileId: root.activeProfileId,
		...root.shared,
		profiles: root.profiles,
	};
	writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
	// It holds API tokens — keep it owner-only like the rest of ~/.odin.
	chmodSync(path, 0o600);
}

/** The active profile's credentials, plus the machine-wide keys. */
export function readOdinConfig(): OdinFileConfig {
	const root = readRoot();
	const active = root.profiles.find((p) => p.id === root.activeProfileId);
	return { ...root.shared, ...active?.config };
}

/**
 * Merge `patch` into the active profile and return the result. A key set to
 * `undefined` is deleted rather than written as null, so "disconnect" leaves
 * no residue.
 */
export function updateOdinConfig(patch: OdinFileConfig): OdinFileConfig {
	const root = readRoot();
	const active =
		root.profiles.find((p) => p.id === root.activeProfileId) ??
		root.profiles[0];
	const shared: Record<string, unknown> = { ...root.shared };
	const config: Record<string, unknown> = { ...active.config };
	for (const [key, value] of Object.entries(patch)) {
		const target = (SHARED_KEYS as readonly string[]).includes(key)
			? shared
			: config;
		if (value === undefined || value === "") delete target[key];
		else target[key] = value;
	}
	active.config = config as OdinFileConfig;
	writeRoot({ ...root, shared: shared as OdinFileConfig });
	return { ...shared, ...config } as OdinFileConfig;
}

export function activeProfileId(): string {
	return readRoot().activeProfileId;
}

export function listProfiles(): {
	id: string;
	name: string;
	active: boolean;
}[] {
	const root = readRoot();
	return root.profiles.map((p) => ({
		id: p.id,
		name: p.name,
		active: p.id === root.activeProfileId,
	}));
}

export function setActiveProfile(id: string): void {
	const root = readRoot();
	if (!root.profiles.some((p) => p.id === id)) {
		throw new Error(`No such profile: ${id}`);
	}
	writeRoot({ ...root, activeProfileId: id });
}

/** A new profile starts empty — you connect its accounts from scratch. */
export function createProfile(name: string): OdinProfile {
	const root = readRoot();
	const profile: OdinProfile = { id: crypto.randomUUID(), name, config: {} };
	writeRoot({ ...root, profiles: [...root.profiles, profile] });
	return profile;
}

export function renameProfile(id: string, name: string): void {
	const root = readRoot();
	const profile = root.profiles.find((p) => p.id === id);
	if (!profile) throw new Error(`No such profile: ${id}`);
	profile.name = name;
	writeRoot(root);
}

/**
 * Delete a profile and its credentials. Returns the profile that is active
 * afterwards. The last profile can't go: Odin always has exactly one set of
 * accounts in play, and "none" has no meaning anywhere downstream.
 *
 * ponytail: the rows the profile owned (Slack queue, sessions, tasks) are left
 * where they are — orphaned, filtered out of every view, and gone for good the
 * next time their table is swept. Delete them eagerly if that ever shows up as
 * real disk.
 */
export function deleteProfile(id: string): string {
	const root = readRoot();
	if (root.profiles.length <= 1) {
		throw new Error("The last profile can't be deleted");
	}
	const profiles = root.profiles.filter((p) => p.id !== id);
	if (profiles.length === root.profiles.length) {
		throw new Error(`No such profile: ${id}`);
	}
	const activeProfileId =
		root.activeProfileId === id ? profiles[0].id : root.activeProfileId;
	writeRoot({ ...root, profiles, activeProfileId });
	return activeProfileId;
}

// ---------------------------------------------------------------------------
// Credential resolution
//
// One place per provider, so the feed that uses a credential and the
// Connections screen that reports on it can never disagree.
//
// An account credential comes from the active profile and nowhere else: it is
// there because someone signed in *on this profile*. The environment is not
// consulted at all — a shell exports one set of accounts, so falling back to
// it would mean a brand-new empty profile came up already signed into the work
// Jira, GitHub and Notion, which is exactly what profiles exist to stop.
//
// The OAuth *apps* below (which Slack/Jira/Notion app Odin is, and
// GitHub's device-flow client id) are not account credentials — they describe
// the build — so those do read the environment, and are shared by every
// profile.
// ---------------------------------------------------------------------------

function fromEnv(...names: string[]): string | null {
	for (const name of names) {
		const value = process.env[name];
		if (value) return value;
	}
	return null;
}

/** App config — this machine's override, else the environment. */
function appValue(
	envNames: string[],
	fileValue: string | undefined,
): string | null {
	if (fileValue) return fileValue;
	return fromEnv(...envNames);
}

/** Slack **user** token — a bot token cannot read my reactions. */
export function resolveSlackToken(): string | null {
	return readOdinConfig().slackToken ?? null;
}

export function resolveGithubToken(): string | null {
	return readOdinConfig().githubToken ?? null;
}

export function resolveNotionToken(): string | null {
	return readOdinConfig().notionToken ?? null;
}

export interface JiraOAuthApp {
	clientId: string;
	clientSecret: string;
	redirectUrl: string;
}

/**
 * The Jira OAuth app, if one is configured. All three parts are required, for
 * the same reason as the others: a half-configured app fails at the exchange,
 * after consent has already been given.
 */
export function resolveJiraOAuthApp(): JiraOAuthApp | null {
	const file = readOdinConfig();
	const clientId =
		appValue(["ODIN_JIRA_CLIENT_ID"], file.jiraClientId) ||
		process.env.ODIN_JIRA_CLIENT_ID_BAKED;
	const clientSecret =
		appValue(["ODIN_JIRA_CLIENT_SECRET"], file.jiraClientSecret) ||
		process.env.ODIN_JIRA_CLIENT_SECRET_BAKED;
	const redirectUrl =
		appValue(["ODIN_JIRA_REDIRECT_URL"], file.jiraRedirectUrl) ||
		process.env.ODIN_JIRA_REDIRECT_URL_BAKED;
	if (!clientId || !clientSecret || !redirectUrl) return null;
	return { clientId, clientSecret, redirectUrl };
}

export interface SlackOAuthApp {
	clientId: string;
	clientSecret: string;
	/** Must match a Redirect URL registered on the Slack app, exactly. */
	redirectUrl: string;
}

/**
 * The Slack app compiled into this build (electron.vite.config.ts `define`).
 *
 * Spelled out statically on purpose: the bundler substitutes literal
 * `process.env.FOO` text and leaves a dynamic `process.env[name]` lookup
 * alone, so these can't go through `fromEnv`. Empty in a build that wasn't
 * given credentials, which is why the checks below test truthiness.
 */
function bakedSlackApp() {
	return {
		clientId: process.env.ODIN_SLACK_CLIENT_ID_BAKED,
		clientSecret: process.env.ODIN_SLACK_CLIENT_SECRET_BAKED,
		redirectUrl: process.env.ODIN_SLACK_REDIRECT_URL_BAKED,
	};
}

/**
 * The Slack OAuth app, if one is configured. All three parts are required —
 * a half-configured app would fail at the exchange, after the person already
 * approved the consent screen, which is the worst place to find out.
 */
export function resolveSlackOAuthApp(): SlackOAuthApp | null {
	const file = readOdinConfig();
	const baked = bakedSlackApp();
	// Baked values come last: a packaged app works out of the box, and anyone
	// pointing Odin at their own Slack app can still override it per machine.
	const clientId =
		appValue(["ODIN_SLACK_CLIENT_ID"], file.slackClientId) || baked.clientId;
	const clientSecret =
		appValue(["ODIN_SLACK_CLIENT_SECRET"], file.slackClientSecret) ||
		baked.clientSecret;
	const redirectUrl =
		appValue(["ODIN_SLACK_REDIRECT_URL"], file.slackRedirectUrl) ||
		baked.redirectUrl;
	if (!clientId || !clientSecret || !redirectUrl) return null;
	return { clientId, clientSecret, redirectUrl };
}

export interface NotionOAuthApp {
	clientId: string;
	clientSecret: string;
	redirectUrl: string;
}

/**
 * The Notion OAuth connection, if one is configured. All three parts are
 * required: a half-configured app fails at the exchange, after the person has
 * already picked pages on the consent screen.
 */
export function resolveNotionOAuthApp(): NotionOAuthApp | null {
	const file = readOdinConfig();
	const clientId =
		appValue(["ODIN_NOTION_CLIENT_ID"], file.notionClientId) ||
		process.env.ODIN_NOTION_CLIENT_ID_BAKED;
	const clientSecret =
		appValue(["ODIN_NOTION_CLIENT_SECRET"], file.notionClientSecret) ||
		process.env.ODIN_NOTION_CLIENT_SECRET_BAKED;
	const redirectUrl =
		appValue(["ODIN_NOTION_REDIRECT_URL"], file.notionRedirectUrl) ||
		process.env.ODIN_NOTION_REDIRECT_URL_BAKED;
	if (!clientId || !clientSecret || !redirectUrl) return null;
	return { clientId, clientSecret, redirectUrl };
}

/**
 * GitHub OAuth app client id for the device flow. Not a secret — that flow has
 * no client secret at all, which is why it suits a desktop app.
 *
 * Same precedence as the Slack app: runtime env, then this machine's config,
 * then whatever the build was compiled with. The baked name is spelled out
 * statically so the bundler can substitute it.
 */
export function resolveGithubClientId(): string | null {
	// `||`, not `??`: an unbaked build substitutes "", and an empty client id
	// would otherwise read as configured and start a doomed device flow.
	return (
		readOdinConfig().githubClientId ||
		fromEnv("ODIN_GITHUB_CLIENT_ID") ||
		process.env.ODIN_GITHUB_CLIENT_ID_BAKED ||
		null
	);
}
