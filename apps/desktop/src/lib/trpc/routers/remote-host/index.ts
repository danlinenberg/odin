import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, safeStorage } from "electron";
import { githubAccessToken } from "main/lib/github-token";
import {
	giveSsmAccess,
	listAwsProfiles,
	listInstances,
	listTagChoices,
	setUpHost,
	startInstance,
} from "main/lib/remote-host/aws-instances";
import { bringSessionHome } from "main/lib/remote-host/bring-home";
import { runSetupToken } from "main/lib/remote-host/claude-token";
import {
	HOST_CONNECTORS,
	type HostConnector,
} from "main/lib/remote-host/host-service";
import { pushHostTokens } from "main/lib/remote-host/host-tokens";
import {
	hostFiles,
	hostNote,
	httpsCloneUrl,
	issueTicket,
	mainCheckoutOf,
	repoNameOf,
	secretsFile,
	sh,
} from "main/lib/remote-host/session";
import { resolveElectronBinary } from "main/lib/terminal-host/electron-binary";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { readOdinConfig, updateOdinConfig } from "../odin-config";
import { scanRepos } from "../repos";
import { getProcessEnvWithShellEnv } from "../workspaces/utils/shell-env";

const run = promisify(execFile);

/** A checkout's origin as an https clone URL, or null. */
const originOf = (path: string) =>
	run("git", ["-C", path, "remote", "get-url", "origin"])
		.then(({ stdout }) => httpsCloneUrl(stdout))
		.catch(() => null);

/**
 * Every repo Odin knows on this computer, by clone URL, so an agent on the
 * host can pick the one its task is about the way a local agent picks a
 * folder.
 */
async function knownRepos(): Promise<string[]> {
	const urls = await Promise.all((await scanRepos()).map(originOf));
	return [...new Set(urls.filter((url): url is string => Boolean(url)))].sort();
}

/** A file small enough to copy to the host with the prompt. */
function isSmallFile(path: string): boolean {
	try {
		const st = statSync(path);
		return st.isFile() && st.size < 50 * 1024 * 1024;
	} catch {
		return false;
	}
}

/** Board sources whose tasks need the user's connectors. */
const FEED_SOURCES = new Set(["slack", "reactions", "notion", "jira"]);

const awsTarget = z.object({
	profile: z.string().optional(),
	region: z.string().optional(),
});
const tagPairs = z.array(z.object({ key: z.string(), value: z.string() }));

function claudeToken(): string | null {
	const saved = readOdinConfig().claudeToken;
	if (!saved || !safeStorage.isEncryptionAvailable()) return null;
	try {
		return safeStorage.decryptString(Buffer.from(saved, "base64"));
	} catch {
		return null;
	}
}

/**
 * The token sessions on the host run Claude with: `claude setup-token`, run
 * by Odin, so turning the host on asks only for an approval in the browser.
 * It bills the user's own plan, and is kept encrypted with safeStorage.
 */
async function ensureClaudeToken(renew = false): Promise<void> {
	if (!renew && claudeToken()) return;
	if (!safeStorage.isEncryptionAvailable()) {
		throw new Error("This computer can't encrypt the Claude token.");
	}
	const token = await runSetupToken();
	updateOdinConfig({
		claudeToken: safeStorage.encryptString(token).toString("base64"),
	});
}

/**
 * Sessions on an EC2 instance the user created: pick it by tags, and the
 * board's sessions run there in tmux, on the user's own Claude plan.
 */
/**
 * GitHub and Jira tokens expire (8 hours, 1 hour), and the host only gets
 * access tokens - two sides refreshing one rotating refresh token would sign
 * one of them out. So while this computer is awake, Odin sends fresh ones.
 */
async function refreshHostTokens(): Promise<void> {
	const host = readOdinConfig().remoteHost;
	if (!host?.on || !host.connectors?.length) return;
	await pushHostTokens(host, host.connectors as HostConnector[]).catch(
		(error) => console.warn("[remote-host] token refresh:", error),
	);
}
setInterval(() => void refreshHostTokens(), 30 * 60_000).unref();

export const createRemoteHostRouter = () =>
	router({
		/** The profile, region and tags you picked, kept in odin.json. */
		awsSettings: publicProcedure.query(
			() => readOdinConfig().awsInstances ?? {},
		),
		setAwsSettings: publicProcedure
			.input(awsTarget.extend({ tags: tagPairs }))
			.mutation(({ input }) => {
				updateOdinConfig({ awsInstances: input });
			}),
		awsProfiles: publicProcedure.query(() => listAwsProfiles()),
		awsTags: publicProcedure
			.input(awsTarget)
			.query(({ input }) => listTagChoices(input)),
		awsInstances: publicProcedure
			.input(awsTarget.extend({ tags: tagPairs }))
			.query(({ input }) => listInstances(input, input.tags)),
		awsStart: publicProcedure
			.input(awsTarget.extend({ id: z.string().min(1) }))
			.mutation(({ input }) => startInstance(input, input.id)),
		/** Installs what sessions need on the instance (Claude, gh, tmux, git); reports what is there. */
		awsSetUp: publicProcedure
			.input(
				awsTarget.extend({
					id: z.string().min(1),
					user: z.string().min(1),
				}),
			)
			.mutation(({ input }) => setUpHost(input, input.id, input.user)),
		/** Lets SSM reach an instance it can't yet - see giveSsmAccess. */
		awsGiveSsmAccess: publicProcedure
			.input(awsTarget.extend({ id: z.string().min(1) }))
			.mutation(({ input }) => giveSsmAccess(input, input.id)),

		/** The host sessions start on; `on: false` keeps them on this computer. */
		get: publicProcedure.query(() => ({
			host: readOdinConfig().remoteHost ?? null,
			hasClaudeToken: Boolean(claudeToken()),
		})),
		/** Picks the host. Turning it on gets a Claude token first if none is saved. */
		set: publicProcedure
			.input(
				awsTarget.extend({
					on: z.boolean(),
					instanceId: z.string().min(1),
					name: z.string(),
					user: z.string().min(1),
					reposRoot: z.string().min(1),
				}),
			)
			.mutation(async ({ input }) => {
				if (input.on) await ensureClaudeToken();
				updateOdinConfig({ remoteHost: input });
			}),
		setOn: publicProcedure.input(z.boolean()).mutation(async ({ input }) => {
			const host = readOdinConfig().remoteHost;
			if (!host) return;
			if (input) await ensureClaudeToken();
			updateOdinConfig({ remoteHost: { ...host, on: input } });
			// Off: no connector tokens stay behind on the host.
			if (!input && host.connectors?.length)
				await pushHostTokens(host, []).catch(() => {});
			else if (input) void refreshHostTokens();
		}),
		/**
		 * The connectors whose tokens live on the host, so sessions there can
		 * use them with this computer asleep. Written at once; Gmail never.
		 */
		setConnectors: publicProcedure
			.input(z.array(z.enum(HOST_CONNECTORS)))
			.mutation(async ({ input }) => {
				const host = readOdinConfig().remoteHost;
				if (!host) throw new Error("No remote host is set up.");
				const kept = await pushHostTokens(host, input);
				updateOdinConfig({ remoteHost: { ...host, connectors: input } });
				return { kept };
			}),
		/** A fresh token from `claude setup-token`, replacing the saved one. */
		renewClaudeToken: publicProcedure.mutation(() => ensureClaudeToken(true)),

		/**
		 * A remote session's conversation, copied here so it resumes on this
		 * computer; its tmux session on the host ends. The folder it resumes
		 * in: the one asked for if it exists, else the repo a gone session
		 * worktree belonged to, else home.
		 */
		bringHome: publicProcedure
			.input(z.object({ sessionId: z.string().min(1), cwd: z.string() }))
			.mutation(async ({ input }) => {
				const host = readOdinConfig().remoteHost;
				if (!host) throw new Error("No remote host is set up.");
				const cwd =
					[input.cwd, mainCheckoutOf(input.cwd)].find(
						(path) => path && existsSync(path),
					) ?? homedir();
				await bringSessionHome(host, input.sessionId, cwd);
				return { cwd };
			}),

		/**
		 * Where a new session runs: the remote host's name, or null for this
		 * computer. Only code work goes to the host - a task with a repo that
		 * has a GitHub origin. Slack, reactions, Notion and Jira tasks stay
		 * here, where the user's connectors are; the host has none.
		 */
		launchTarget: publicProcedure
			.input(
				z.object({
					repoPath: z.string().nullable(),
					source: z.string().nullable(),
				}),
			)
			.query(async ({ input }) => {
				const host = readOdinConfig().remoteHost;
				if (!host?.on || !input.repoPath) return null;
				if (input.source && FEED_SOURCES.has(input.source)) return null;
				const origin =
					(await originOf(input.repoPath)) ??
					(await originOf(mainCheckoutOf(input.repoPath)));
				return origin ? host.name || host.instanceId : null;
			}),

		/** The command a remote session's pane runs. */
		sessionCommand: publicProcedure
			.input(
				z.object({
					pane: z.string().min(1),
					/** The local checkout; the host clones the same origin. */
					repoPath: z.string().nullable(),
					claudeArgs: z.string(),
					prompt: z.string().nullable(),
					/** Odin's pane, for the session's calls back to Odin. */
					odinPane: z.string().nullable().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				// Not gated on `on`: that switch picks where new sessions start,
				// and a session already on the host resumes there either way.
				const host = readOdinConfig().remoteHost;
				if (!host) throw new Error("No remote host is set up.");
				const { repoPath, ...rest } = input;
				// The repo is its origin. A session worktree that is gone still
				// names its repo: it lived at <repo>/.worktrees/<name>.
				const origin = repoPath
					? ((await originOf(repoPath)) ??
						(await originOf(mainCheckoutOf(repoPath))))
					: null;
				const repoName = origin ? repoNameOf(origin) : null;
				const { prompt, files } = rest.prompt
					? hostFiles(rest.prompt, host.user, isSmallFile)
					: { prompt: null, files: [] };
				const spec = Buffer.from(
					JSON.stringify({
						...host,
						...rest,
						prompt:
							prompt === null
								? null
								: prompt +
									hostNote({
										user: host.user,
										name: host.name || host.instanceId,
										repoName,
										pane: rest.pane,
										known: repoName ? [] : await knownRepos(),
									}),
						files,
						repoName,
						cloneUrl: origin,
					}),
				).toString("base64");
				const ticket = issueTicket(
					secretsFile({
						CLAUDE_CODE_OAUTH_TOKEN: claudeToken() ?? undefined,
						// The API key claude-auto falls back to here, for the same switch on the host.
						ODIN_FALLBACK_API_KEY: (await getProcessEnvWithShellEnv())
							.ANTHROPIC_API_KEY,
						GH_TOKEN: (await githubAccessToken()) ?? undefined,
					}),
				);
				const script = join(
					app.getAppPath(),
					"dist",
					"main",
					"remote-shell.js",
				);
				return `ELECTRON_RUN_AS_NODE=1 ${sh(resolveElectronBinary())} ${sh(script)} ${spec} ${ticket}`;
			}),
	});
