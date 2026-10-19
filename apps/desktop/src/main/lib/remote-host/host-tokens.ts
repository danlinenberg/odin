import {
	readOdinConfig,
	resolveNotionToken,
	resolveSlackToken,
} from "lib/trpc/routers/odin-config";
import { githubAccessToken } from "../github-token";
import { jiraRequestContext } from "../jira-token";
import {
	HOST_TOKENS_FILE,
	type HostConnector,
	hostServiceInstallScript,
} from "./host-service";
import { sh } from "./session";
import { connectHost, type HostLogin, runOnHost } from "./ssh";

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
			const token = await githubAccessToken();
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
 * Writes the tokens on the host as the `odin` user's file, mode 0600, over
 * SSH stdin - never on a command line, and never through an SSM command,
 * which AWS keeps in its command history. An empty set wipes the file.
 */
export const writeTokensScript = `sudo -n sh -c 'umask 077; f=${HOST_TOKENS_FILE}; cat > "$f.new" && chown odin:odin "$f.new" && mv "$f.new" "$f"'`;

export async function pushHostTokens(
	host: HostLogin,
	connectors: readonly HostConnector[],
): Promise<string[]> {
	const tokens = await hostTokens(connectors);
	const client = await connectHost(host);
	try {
		// The first switch installs the service too, so no Set up is needed first.
		await runOnHost(
			client,
			`[ -d /var/lib/odin ] || sudo -n bash -c ${sh(hostServiceInstallScript)}`,
		);
		await runOnHost(client, writeTokensScript, JSON.stringify(tokens));
	} catch (error) {
		throw new Error(
			`Couldn't write the tokens on the host: ${error instanceof Error ? error.message : String(error)}. ${host.user} needs passwordless sudo, as the default user on EC2 has, and the host needs systemd.`,
		);
	} finally {
		client.end();
	}
	return Object.keys(tokens).filter((key) => key !== "jiraBase");
}
