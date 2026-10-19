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
import {
	CLAUDE_SETUP_PARTS,
	syncClaudeSetup,
} from "main/lib/remote-host/claude-sync";
import { runSetupToken } from "main/lib/remote-host/claude-token";
import {
	HOST_CONNECTORS,
	type HostConnector,
} from "main/lib/remote-host/host-service";
import { pushHostTokens } from "main/lib/remote-host/host-tokens";
import {
	pushNightPlan,
	readNightStarted,
	SECRETS_DIR_PLACEHOLDER,
} from "main/lib/remote-host/night";
import {
	hostFiles,
	hostNote,
	httpsCloneUrl,
	issueTicket,
	mainCheckoutOf,
	type RemoteSessionSpec,
	repoNameOf,
	runScript,
	secretsFile,
	sh,
} from "main/lib/remote-host/session";
import { copyFilesToHost } from "main/lib/remote-host/ssh";
import { resolveElectronBinary } from "main/lib/terminal-host/electron-binary";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { readOdinConfig, updateOdinConfig } from "../odin-config";
import { scanRepos } from "../repos";
import { getProcessEnvWithShellEnv } from "../workspaces/utils/shell-env";

const run = promisify(execFile);

type RemoteHost = NonNullable<ReturnType<typeof readOdinConfig>["remoteHost"]>;

/**
 * A session's spec for the host: the repo from the local checkout's origin, the
 * prompt with laptop files swapped for their copies and the host note added.
 */
async function buildSessionSpec(
	host: RemoteHost,
	input: {
		pane: string;
		repoPath: string | null;
		claudeArgs: string;
		prompt: string | null;
		odinPane?: string | null;
	},
): Promise<RemoteSessionSpec> {
	const { repoPath, ...rest } = input;
	// The repo is its origin. A session worktree that is gone still
	// names its repo: it lived at <repo>/.worktrees/<name>.
	const origin = repoPath
		? ((await originOf(repoPath)) ?? (await originOf(mainCheckoutOf(repoPath))))
		: null;
	const repoName = origin ? repoNameOf(origin) : null;
	const { prompt, files } = rest.prompt
		? hostFiles(rest.prompt, host.user, isSmallFile)
		: { prompt: null, files: [] };
	return {
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
	};
}

/** What a session on the host starts with, as KEY='value' lines. */
async function sessionSecrets(): Promise<string> {
	return secretsFile({
		CLAUDE_CODE_OAUTH_TOKEN: claudeToken() ?? undefined,
		// The API key claude-auto falls back to here, for the same switch on the host.
		ODIN_FALLBACK_API_KEY:
			readOdinConfig().remoteHost?.apiKeyFallback !== true
				? undefined
				: (await getProcessEnvWithShellEnv()).ANTHROPIC_API_KEY,
		GH_TOKEN: (await githubAccessToken()) ?? undefined,
	});
}

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

/** The connector a board source's tasks need on the host. */
const CONNECTOR_OF: Record<string, HostConnector> = {
	slack: "slack",
	reactions: "slack",
	notion: "notion",
	jira: "jira",
};

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
		/**
		 * Copies the chosen parts of ~/.claude (instructions, skills, commands,
		 * plugins, settings) to the host, so sessions there work as here.
		 */
		syncClaudeSetup: publicProcedure
			.input(z.array(z.enum(CLAUDE_SETUP_PARTS)))
			.mutation(async ({ input }) => {
				const host = readOdinConfig().remoteHost;
				if (!host) throw new Error("No remote host is set up.");
				const { bytes, dropped } = await syncClaudeSetup(host, input);
				updateOdinConfig({
					remoteHost: {
						...host,
						claudeSetup: input,
						claudeSetupSyncedAt: Date.now(),
						claudeSetupDropped: dropped,
					},
				});
				return { bytes, dropped };
			}),
		/** Whether host sessions move to ANTHROPIC_API_KEY at the plan limit. */
		setApiKeyFallback: publicProcedure
			.input(z.boolean())
			.mutation(({ input }) => {
				const host = readOdinConfig().remoteHost;
				if (!host) throw new Error("No remote host is set up.");
				updateOdinConfig({ remoteHost: { ...host, apiKeyFallback: input } });
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
		 * computer. With the host on, everything goes there - a task without a
		 * repo picks one from the list the host note gives it. Except a Slack,
		 * reactions, Notion or Jira task whose connector isn't on the host: it
		 * would fail there, so it stays here.
		 */
		launchTarget: publicProcedure
			.input(
				z.object({
					repoPath: z.string().nullable(),
					source: z.string().nullable(),
				}),
			)
			.query(({ input }) => {
				const host = readOdinConfig().remoteHost;
				if (!host?.on) return null;
				const needs = input.source ? CONNECTOR_OF[input.source] : undefined;
				if (needs && !host.connectors?.includes(needs)) return null;
				return host.name || host.instanceId;
			}),

		/**
		 * A message to a session on the host: the laptop files it names or
		 * attaches, copied to ~/.odin/files there, and the text and paths
		 * rewritten to the copies. Unchanged when nothing is a laptop file.
		 */
		filesToHost: publicProcedure
			.input(z.object({ text: z.string(), paths: z.array(z.string()) }))
			.mutation(async ({ input }) => {
				const host = readOdinConfig().remoteHost;
				if (!host) return input;
				const marker = "\u0000ODIN-PATH\u0000";
				const { prompt, files } = hostFiles(
					[input.text, ...input.paths].join(marker),
					host.user,
					isSmallFile,
					`${Date.now()}-`,
				);
				if (!files.length) return input;
				await copyFilesToHost(host, files);
				const [text = "", ...paths] = prompt.split(marker);
				return { text, paths };
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
				const spec = Buffer.from(
					JSON.stringify(await buildSessionSpec(host, input)),
				).toString("base64");
				const ticket = issueTicket(await sessionSecrets());
				const script = join(
					app.getAppPath(),
					"dist",
					"main",
					"remote-shell.js",
				);
				return `ELECTRON_RUN_AS_NODE=1 ${sh(resolveElectronBinary())} ${sh(script)} ${spec} ${ticket}`;
			}),

		/**
		 * Tonight's Night Agent plan, sent to the host's runner: each task as a
		 * ready session script (its prompt built here, as a launch would), the
		 * window as epoch seconds, the cap. See main/lib/remote-host/night.
		 */
		nightPush: publicProcedure
			.input(
				z.object({
					from: z.number(),
					to: z.number(),
					cap: z.number().int().min(0),
					tasks: z.array(
						z.object({
							key: z.string(),
							title: z.string(),
							sessionId: z.string().min(1),
							repoPath: z.string().nullable(),
							prompt: z.string(),
						}),
					),
				}),
			)
			.mutation(async ({ input }) => {
				const host = readOdinConfig().remoteHost;
				if (!host?.on) throw new Error("The remote host is off.");
				const files: { local: string; remote: string }[] = [];
				const tasks = [];
				for (const task of input.tasks) {
					const spec = await buildSessionSpec(host, {
						pane: task.sessionId,
						repoPath: task.repoPath,
						claudeArgs: `--session-id ${task.sessionId}`,
						prompt: task.prompt,
					});
					files.push(...(spec.files ?? []));
					tasks.push({
						key: task.key,
						title: task.title,
						sessionId: task.sessionId,
						script: runScript(spec, SECRETS_DIR_PLACEHOLDER),
					});
				}
				await pushNightPlan(
					host,
					{
						id: crypto.randomUUID(),
						from: input.from,
						to: input.to,
						cap: input.cap,
						tasks,
					},
					await sessionSecrets(),
					files,
				);
				return { sent: tasks.length };
			}),
		/** What the host's runner started tonight, for the board to adopt. */
		nightStarted: publicProcedure.query(async () => {
			const host = readOdinConfig().remoteHost;
			if (!host?.on) return [];
			return readNightStarted(host);
		}),
	});
