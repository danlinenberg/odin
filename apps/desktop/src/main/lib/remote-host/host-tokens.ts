import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	readOdinConfig,
	resolveNotionToken,
	resolveSlackToken,
} from "lib/trpc/routers/odin-config";
import type { Client } from "ssh2";
import { jiraRequestContext } from "../jira-token";
import { awsHostConfigScript, localAwsProfiles } from "./aws-on-host";
import type { HostGithubPair } from "./github-host-login";
import {
	hostGithubAccounts,
	hostGithubLogin,
	hostGithubToken,
	hostGithubTokens,
} from "./github-on-host";
import {
	HOST_PORT_SH,
	HOST_SERVICE_PY,
	type HostConnector,
	type HostTokensFile,
	hostGithubLoginFile,
	hostServiceInstallScript,
} from "./host-service";
import { GITHUB_HELPERS_SCRIPT, sh } from "./session";
import { adminLogin, connectHost, type HostLogin, runOnHost } from "./ssh";

/**
 * A GitHub token sent to the host is good for at least this long. Copies go
 * every 30 minutes while this computer is awake (the remote-host router), so
 * one sent with less left than that would die before the next.
 */
export const HOST_GITHUB_TOKEN_MARGIN_MS = 45 * 60_000;

/**
 * The tokens of the connectors the user keeps on the host, as the host
 * service reads them, and this computer's GitHub tokens for sessions there:
 * those go whether or not the GitHub connector is on, since a session's git
 * and gh get their token from the service now (session.ts).
 */
export async function hostTokens(
	connectors: readonly HostConnector[],
): Promise<HostTokensFile> {
	const config = readOdinConfig();
	const tokens: HostTokensFile = {};
	for (const name of connectors) {
		if (name === "slack") {
			const token = resolveSlackToken();
			if (token) tokens.slack = token;
		} else if (name === "notion") {
			const token = resolveNotionToken();
			if (token) tokens.notion = token;
		} else if (name === "clickup") {
			const token = config.clickupToken;
			if (token) tokens.clickup = token;
		} else if (name === "jira") {
			const ctx = await jiraRequestContext();
			if (ctx) {
				tokens.jira = ctx.authorization.replace(/^Bearer /, "");
				tokens.jiraBase = ctx.base;
			}
		}
	}
	// The default account (the main one when it may go), and every allowed one by login.
	const github = await hostGithubToken(
		config,
		null,
		HOST_GITHUB_TOKEN_MARGIN_MS,
	);
	if (github) tokens.github = github;
	const login = hostGithubLogin(config);
	if (login) tokens.githubLogin = login.toLowerCase();
	const accounts = await hostGithubTokens(config, HOST_GITHUB_TOKEN_MARGIN_MS);
	if (Object.keys(accounts).length) tokens.githubAccounts = accounts;
	if (connectors.includes("github") && github) tokens.githubConnector = true;
	return tokens;
}

/** The connectors a tokens file serves. */
export function keptConnectors(tokens: HostTokensFile): string[] {
	return [
		...(["slack", "notion", "clickup", "jira"] as const).filter(
			(name) => tokens[name],
		),
		...(tokens.githubConnector ? ["github"] : []),
	];
}

/**
 * The helper and wrapper a session's git and gh sign in through, put in the
 * user's home by the user themselves. A session running from before they
 * existed gets fresh tokens from its next git or gh call on. Under the
 * user's setup lock, as a session's own install is (session.ts).
 */
export const HELPERS_AS_USER = `mkdir -p "$HOME/.odin" && exec 9>"$HOME/.odin/setup.lock" && flock -w 120 9\n${GITHUB_HELPERS_SCRIPT}\ntrue\n`;

/** This computer's git `user.name` and `user.email`, either missing when unset. */
export async function localGitIdentity(): Promise<{
	name?: string;
	email?: string;
}> {
	const get = (key: string) =>
		promisify(execFile)("git", ["config", "--global", "--get", key], {
			timeout: 5_000,
		}).then(
			({ stdout }) => stdout.trim() || undefined,
			() => undefined,
		);
	const [name, email] = await Promise.all([
		get("user.name"),
		get("user.email"),
	]);
	return { name, email };
}

/**
 * Run as the host user: their git identity there is this computer's, so the
 * commits in a PR their own GitHub token opens are theirs too. A value the user
 * set on the host themselves stays.
 */
export function gitIdentityScript(identity: {
	name?: string;
	email?: string;
}): string {
	return (["name", "email"] as const)
		.filter((key) => identity[key])
		.map(
			(key) =>
				`git config --global --get user.${key} >/dev/null || git config --global user.${key} ${sh(identity[key] ?? "")}`,
		)
		.join("\n");
}

/** Prints "current" when this user's service is installed and runs this Odin's script; read as the user. */
export const SERVICE_CURRENT_SCRIPT = (user: string) =>
	`[ -f /etc/systemd/system/odin-host-${user}.service ] && cmp -s /usr/local/lib/odin/host-service.py - && echo current; true`;

/** Sends `body` to the user's own host service at `path`, from stdin: no sudo, and no token on a command line. */
export const postToServiceScript = (path: string) =>
	`curl -sf -m 30 --data-binary @- "http://127.0.0.1:${HOST_PORT_SH}${path}" >/dev/null`;

/**
 * The service, installed or brought up to date, for this host user. Root's
 * work, so as the instance's own login - which only an administrator's AWS
 * sign-in may use. Everyone else's Odin skips it while their service runs a
 * script that takes their tokens; `required` says it can't go on without.
 */
async function ensureHostService(
	host: HostLogin,
	client: Client,
	required: boolean,
): Promise<void> {
	const state = await runOnHost(
		client,
		SERVICE_CURRENT_SCRIPT(host.user),
		HOST_SERVICE_PY,
	);
	if (state === "current") return;
	try {
		const admin = await connectHost(adminLogin(host));
		try {
			await runOnHost(
				admin,
				`sudo -n bash -c ${sh(hostServiceInstallScript(host.user))}`,
			);
		} finally {
			admin.end();
		}
	} catch (error) {
		if (required) throw error;
	}
}

const adminHint = (host: HostLogin) =>
	`Setting up or updating Odin's service on the host is an administrator's work: one with an AWS administrator role opens Settings > Remote > Set up a user on this host, for ${host.user}.`;

/**
 * Sends the host user's tokens: the connectors' and GitHub's for sessions.
 * Returns the connectors the host now serves.
 */
export async function pushHostTokens(
	host: HostLogin & { awsProfiles?: string[] },
	connectors: readonly HostConnector[],
): Promise<string[]> {
	const tokens = await hostTokens(connectors);
	// The AWS profiles picked for the host, on its role, with this computer's region for each.
	const regions = new Map(localAwsProfiles().map((p) => [p.name, p.region]));
	const awsConfig = awsHostConfigScript(
		(host.awsProfiles ?? []).map((name) => ({
			name,
			region: regions.get(name),
		})),
	);
	const allowed = hostGithubAccounts(readOdinConfig())
		.filter((account) => account.onHost)
		.map((account) => account.login);
	// As the host user: their own service takes the tokens, so no sudo.
	const client = await connectHost(host);
	try {
		await ensureHostService(host, client, false);
		await runOnHost(
			client,
			postToServiceScript("/tokens"),
			JSON.stringify({ tokens, githubKeep: allowed }),
		);
		const identity = gitIdentityScript(await localGitIdentity());
		await runOnHost(
			client,
			"bash",
			`${HELPERS_AS_USER}${awsConfig}\n${identity}\ntrue\n`,
		);
	} catch (error) {
		throw new Error(
			`Couldn't send the tokens to the host: ${error instanceof Error ? error.message : String(error)}. ${adminHint(host)}`,
		);
	} finally {
		client.end();
	}
	return keptConnectors(tokens);
}

/**
 * Sends the host its own GitHub sign-in for `login`: the pair from the device
 * flow run for it (github-host-login), which the service refreshes from then
 * on. This computer keeps no copy: the refresh token rotates on every use,
 * and two holders would sign each other out.
 */
export async function pushHostGithubPair(
	host: HostLogin,
	login: string,
	pair: HostGithubPair,
): Promise<void> {
	hostGithubLoginFile(login);
	const client = await connectHost(host);
	try {
		await ensureHostService(host, client, false);
		await runOnHost(
			client,
			postToServiceScript(`/github-pair?login=${login.toLowerCase()}`),
			JSON.stringify(pair),
		);
		await runOnHost(client, "bash", HELPERS_AS_USER);
	} catch (error) {
		throw new Error(
			`Couldn't send the sign-in to the host: ${error instanceof Error ? error.message : String(error)}. ${adminHint(host)}`,
		);
	} finally {
		client.end();
	}
}
