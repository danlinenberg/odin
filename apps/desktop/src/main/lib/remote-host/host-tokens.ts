import {
	readOdinConfig,
	resolveNotionToken,
	resolveSlackToken,
} from "lib/trpc/routers/odin-config";
import { jiraRequestContext } from "../jira-token";
import { hostGithubToken } from "./github-on-host";
import {
	HOST_SERVICE_PY,
	type HostConnector,
	hostServiceInstallScript,
	hostTokensFile,
} from "./host-service";
import { sh } from "./session";
import { adminLogin, connectHost, type HostLogin, runOnHost } from "./ssh";

/** The tokens of the connectors the user keeps on the host, as the host service reads them. */
export async function hostTokens(
	connectors: readonly HostConnector[],
): Promise<Record<string, string>> {
	const tokens: Record<string, string> = {};
	for (const name of connectors) {
		if (name === "slack") {
			const token = resolveSlackToken();
			if (token) tokens.slack = token;
		} else if (name === "notion") {
			const token = resolveNotionToken();
			if (token) tokens.notion = token;
		} else if (name === "clickup") {
			const token = readOdinConfig().clickupToken;
			if (token) tokens.clickup = token;
		} else if (name === "github") {
			// The account allowed on the host, not whichever is main.
			const token = await hostGithubToken(readOdinConfig());
			if (token) tokens.github = token;
		} else if (name === "jira") {
			const ctx = await jiraRequestContext();
			if (ctx) {
				tokens.jira = ctx.authorization.replace(/^Bearer /, "");
				tokens.jiraBase = ctx.base;
			}
		}
	}
	return tokens;
}

/**
 * Writes a host user's tokens as the `odin` user's file, mode 0600, over SSH
 * stdin - never on a command line, and never through an SSM command, which
 * AWS keeps in its command history. An empty set wipes the file.
 */
export const writeTokensScript = (user: string) =>
	`sudo -n sh -c 'umask 077; f=${hostTokensFile(user)}; cat > "$f.new" && chown odin:odin "$f.new" && mv "$f.new" "$f"'`;

export async function pushHostTokens(
	host: HostLogin,
	connectors: readonly HostConnector[],
): Promise<string[]> {
	const tokens = await hostTokens(connectors);
	// Root's work, so as the instance's own login; the tokens are the host user's.
	const client = await connectHost(adminLogin(host));
	try {
		// The first switch installs the user's service too, so no Set up is
		// needed first; a newer service script replaces the running one.
		await runOnHost(
			client,
			`[ -f /etc/systemd/system/odin-host-${host.user}.service ] && cmp -s /usr/local/lib/odin/host-service.py - || sudo -n bash -c ${sh(hostServiceInstallScript(host.user))}`,
			HOST_SERVICE_PY,
		);
		await runOnHost(
			client,
			writeTokensScript(host.user),
			JSON.stringify(tokens),
		);
	} catch (error) {
		throw new Error(
			`Couldn't write the tokens on the host: ${error instanceof Error ? error.message : String(error)}. ${adminLogin(host).user} needs passwordless sudo, as the default user on EC2 has, and the host needs systemd.`,
		);
	} finally {
		client.end();
	}
	return Object.keys(tokens).filter((key) => key !== "jiraBase");
}
