import {
	readOdinConfig,
	resolveNotionToken,
	resolveSlackToken,
} from "lib/trpc/routers/odin-config";
import type { Client } from "ssh2";
import { jiraRequestContext } from "../jira-token";
import type { HostGithubPair } from "./github-host-login";
import {
	hostGithubAccounts,
	hostGithubLogin,
	hostGithubToken,
	hostGithubTokens,
} from "./github-on-host";
import {
	HOST_SERVICE_PY,
	type HostConnector,
	type HostTokensFile,
	hostGithubDir,
	hostGithubLoginFile,
	hostServiceInstallScript,
	hostTokensFile,
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
 * Writes a host user's tokens as the `odin` user's file, mode 0600, over SSH
 * stdin - never on a command line, and never through an SSM command, which
 * AWS keeps in its command history. An empty set wipes the file.
 */
export const writeTokensScript = (user: string) =>
	`sudo -n sh -c 'umask 077; f=${hostTokensFile(user)}; cat > "$f.new" && chown odin:odin "$f.new" && mv "$f.new" "$f"'`;

/** Root writes a host sign-in's pair as the service's file for that login, from stdin. */
export const writeGithubPairScript = (user: string, login: string) => {
	const dir = hostGithubDir(user);
	return `sudo -n sh -c 'umask 077; install -d -m 700 -o odin -g odin ${dir}; f=${dir}/${hostGithubLoginFile(login)}; cat > "$f.new" && chown odin:odin "$f.new" && mv "$f.new" "$f"'`;
};

/** Root drops the host's own sign-ins for every account but `keep`: one turned off is off. */
export const pruneGithubPairsScript = (user: string, keep: string[]) => {
	const names = keep.map((login) => hostGithubLoginFile(login).slice(0, -5));
	return `sudo -n sh -c 'cd ${hostGithubDir(user)} 2>/dev/null || exit 0; for f in *.json; do case " ${names.join(" ")} " in *" $${"{f%.json}"} "*) ;; *) rm -f -- "$f";; esac; done'`;
};

/**
 * The helper and wrapper a session's git and gh sign in through, put in the
 * user's home by root. A session running from before they existed gets fresh
 * tokens from its next git or gh call on. Under the user's setup lock, as a
 * session's own install is (session.ts).
 */
export const installHelpersScript = (user: string) =>
	`if id -u ${sh(user)} >/dev/null 2>&1; then sudo -n -u ${sh(user)} -H bash; fi`;
export const HELPERS_AS_USER = `mkdir -p "$HOME/.odin" && exec 9>"$HOME/.odin/setup.lock" && flock -w 120 9\n${GITHUB_HELPERS_SCRIPT}\ntrue\n`;

/** The service, installed or brought up to date, for this host user. */
async function ensureHostService(client: Client, user: string): Promise<void> {
	// The first switch installs the user's service too, so no Set up is
	// needed first; a newer service script replaces the running one.
	await runOnHost(
		client,
		`[ -f /etc/systemd/system/odin-host-${user}.service ] && cmp -s /usr/local/lib/odin/host-service.py - || sudo -n bash -c ${sh(hostServiceInstallScript(user))}`,
		HOST_SERVICE_PY,
	);
}

const sudoHint = (host: HostLogin) =>
	`${adminLogin(host).user} needs passwordless sudo, as the default user on EC2 has, and the host needs systemd.`;

/**
 * Sends the host user's tokens: the connectors' and GitHub's for sessions.
 * Returns the connectors the host now serves.
 */
export async function pushHostTokens(
	host: HostLogin,
	connectors: readonly HostConnector[],
): Promise<string[]> {
	const tokens = await hostTokens(connectors);
	const allowed = hostGithubAccounts(readOdinConfig())
		.filter((account) => account.onHost)
		.map((account) => account.login);
	// Root's work, so as the instance's own login; the tokens are the host user's.
	const client = await connectHost(adminLogin(host));
	try {
		await ensureHostService(client, host.user);
		await runOnHost(
			client,
			writeTokensScript(host.user),
			JSON.stringify(tokens),
		);
		await runOnHost(client, pruneGithubPairsScript(host.user, allowed));
		await runOnHost(client, installHelpersScript(host.user), HELPERS_AS_USER);
	} catch (error) {
		throw new Error(
			`Couldn't write the tokens on the host: ${error instanceof Error ? error.message : String(error)}. ${sudoHint(host)}`,
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
	const client = await connectHost(adminLogin(host));
	try {
		await ensureHostService(client, host.user);
		await runOnHost(
			client,
			writeGithubPairScript(host.user, login),
			JSON.stringify(pair),
		);
		await runOnHost(client, installHelpersScript(host.user), HELPERS_AS_USER);
	} catch (error) {
		throw new Error(
			`Couldn't write the sign-in on the host: ${error instanceof Error ? error.message : String(error)}. ${sudoHint(host)}`,
		);
	} finally {
		client.end();
	}
}
