import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, safeStorage } from "electron";
import { getNotifyScriptPath } from "main/lib/agent-setup/notify-hook";
import { githubOwner } from "main/lib/github-token";
import { apiKeyFallbackOn } from "main/lib/remote-host/api-key-fallback";
import {
	giveSsmAccess,
	listAwsProfiles,
	listInstances,
	listTagChoices,
	setUpHost,
	startInstance,
} from "main/lib/remote-host/aws-instances";
import {
	bringMirrorHome,
	bringSessionHome,
	endHostSession,
	type HostWork,
	movedNote,
	unpackWork,
	unreachableNote,
} from "main/lib/remote-host/bring-home";
import {
	CLAUDE_SETUP_PARTS,
	syncClaudeSetup,
} from "main/lib/remote-host/claude-sync";
import { runClaudeLogin } from "main/lib/remote-host/claude-token";
import {
	hostGithubAccounts,
	hostGithubToken,
	repoStaysLocal,
} from "main/lib/remote-host/github-on-host";
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
	type ClaudeLogin,
	HOST_NOTIFY_HOOK,
	hostFiles,
	hostNote,
	httpsCloneUrl,
	issueTicket,
	linuxUserName,
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
import { awsSsoLogin } from "../terminal/aws-sso";
import { getProcessEnvWithShellEnv } from "../workspaces/utils/shell-env";

const run = promisify(execFile);

/**
 * This Odin user's Linux user on the host: the one already chosen, so a
 * changed GitHub login never strands a home full of repos; else a new one.
 */
function hostUser(): string {
	const config = readOdinConfig();
	if (config.remoteHost?.adminUser) return config.remoteHost.user;
	return linuxUserName(config.githubLogin || userInfo().username);
}

/**
 * Runs an SSM call to the host; on an expired AWS SSO session it signs in
 * again (the browser approval) and tries once more, as host sessions do.
 */
async function withAwsSignIn<T>(host: RemoteHost, call: () => Promise<T>) {
	try {
		return await call();
	} catch (err) {
		if (
			!/SSO session|token (has expired|is expired)|ExpiredToken/i.test(
				String(err),
			)
		)
			throw err;
		await awsSsoLogin(host.profile ?? null);
		return call();
	}
}

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
		fresh?: boolean;
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
		// A resumed conversation already has the host note.
		prompt:
			prompt === null || /--resume\b/.test(rest.claudeArgs)
				? prompt
				: prompt +
					hostNote({
						user: host.user,
						name: host.name || host.instanceId,
						repoName,
						pane: rest.pane,
						known: repoName ? [] : await knownRepos(),
					}),
		files: existsSync(getNotifyScriptPath())
			? [...files, { local: getNotifyScriptPath(), remote: HOST_NOTIFY_HOOK }]
			: files,
		repoName,
		cloneUrl: origin,
	};
}

/** What a session on the host starts with, as KEY='value' lines. */
async function sessionSecrets(owner: string | null = null): Promise<string> {
	return secretsFile({
		...claudeSecrets(),
		// The API key claude-auto falls back to here, for the same switch on the host.
		ODIN_FALLBACK_API_KEY: apiKeyFallbackOn(
			readOdinConfig().remoteHost?.apiKeyFallback,
		)
			? (await getProcessEnvWithShellEnv()).ANTHROPIC_API_KEY
			: undefined,
		// The repo owner's account when it may go to the host (github-on-host).
		GH_TOKEN: await hostGithubToken(readOdinConfig(), owner),
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

/** This computer's checkout of the repo cloned from `url`, if it has one. */
async function localCheckoutOf(url: string): Promise<string | null> {
	for (const repo of await scanRepos())
		if ((await originOf(repo)) === url) return repo;
	return null;
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

/**
 * A saved sign-in (JSON, from `claude auth login`) goes to the host to sign in
 * with; an older `claude setup-token` token is used as it is until renewed.
 */
function claudeSecrets(): Record<string, string | undefined> {
	const saved = claudeToken();
	if (!saved?.startsWith("{"))
		return { CLAUDE_CODE_OAUTH_TOKEN: saved ?? undefined };
	const login = JSON.parse(saved) as ClaudeLogin;
	return {
		ODIN_CLAUDE_REFRESH_TOKEN: login.refreshToken,
		ODIN_CLAUDE_SCOPES: login.scopes,
		ODIN_CLAUDE_LOGIN_ID: login.id,
	};
}

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
 * The sign-in sessions on the host run Claude with: `claude auth login`, run
 * by Odin, so turning the host on asks only for an approval in the browser.
 * It bills the user's own plan, and is kept encrypted with safeStorage.
 */
async function ensureClaudeToken(renew = false): Promise<void> {
	if (!renew && claudeToken()) return;
	if (!safeStorage.isEncryptionAvailable()) {
		throw new Error("This computer can't encrypt the Claude token.");
	}
	const login = await runClaudeLogin();
	updateOdinConfig({
		claudeToken: safeStorage
			.encryptString(JSON.stringify(login))
			.toString("base64"),
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
		/** Installs what sessions need on the instance (Claude, gh, tmux, git, this user's Linux user); reports what is there. */
		awsSetUp: publicProcedure
			.input(awsTarget.extend({ id: z.string().min(1) }))
			.mutation(({ input }) => setUpHost(input, input.id, hostUser())),
		/** Lets SSM reach an instance it can't yet - see giveSsmAccess. */
		awsGiveSsmAccess: publicProcedure
			.input(awsTarget.extend({ id: z.string().min(1) }))
			.mutation(({ input }) => giveSsmAccess(input, input.id)),

		/** The host sessions start on; `on: false` keeps them on this computer. */
		get: publicProcedure.query(() => ({
			host: readOdinConfig().remoteHost ?? null,
			/** The Linux user this computer's sessions run as on a host. */
			hostUser: hostUser(),
			hasClaudeToken: Boolean(claudeToken()),
			/** Whether sessions there move to the API key at the plan limit. */
			apiKeyFallback: apiKeyFallbackOn(
				readOdinConfig().remoteHost?.apiKeyFallback,
			),
			/** The connected GitHub accounts and which may go to the host. */
			githubAccounts: hostGithubAccounts(readOdinConfig()),
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
				// `user` from the picker is the instance's login; sessions run as this user's own.
				updateOdinConfig({
					remoteHost: { ...input, user: hostUser(), adminUser: input.user },
				});
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
				const kept = await withAwsSignIn(host, () =>
					pushHostTokens(host, input),
				);
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
				const { bytes, dropped } = await withAwsSignIn(host, () =>
					syncClaudeSetup(host, input),
				);
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
		/**
		 * Which connected GitHub accounts may go to the host, by login. The
		 * GitHub connector there, when kept, is rewritten to follow the choice.
		 */
		setGithubOnHost: publicProcedure
			.input(z.array(z.string()))
			.mutation(async ({ input }) => {
				const host = readOdinConfig().remoteHost;
				if (!host) throw new Error("No remote host is set up.");
				updateOdinConfig({ remoteHost: { ...host, githubOnHost: input } });
				if (host.connectors?.includes("github"))
					await pushHostTokens(host, host.connectors as HostConnector[]);
			}),
		/** A fresh token from `claude setup-token`, replacing the saved one. */
		renewClaudeToken: publicProcedure.mutation(() => ensureClaudeToken(true)),

		/**
		 * A remote session, moved to this computer with its code: the host
		 * branch, its commits and its uncommitted work land in a worktree of
		 * this computer's checkout of the same repo, and the conversation
		 * resumes there; its tmux session on the host ends. With no such
		 * checkout: the folder asked for if it exists, else the repo a gone
		 * session worktree belonged to, else home. `note` is what the resumed
		 * Claude is told first.
		 */
		bringHome: publicProcedure
			.input(z.object({ sessionId: z.string().min(1), cwd: z.string() }))
			.mutation(async ({ input }) => {
				const host = readOdinConfig().remoteHost;
				if (!host) throw new Error("No remote host is set up.");
				let branch: string | null = null;
				const placeIn = async (work: HostWork | null) => {
					const origin = work?.origin ? httpsCloneUrl(work.origin) : null;
					const repo = origin ? await localCheckoutOf(origin) : null;
					if (repo && work?.bundle && work.branch) {
						const unpacked = await unpackWork(repo, {
							...work,
							bundle: work.bundle,
							branch: work.branch,
						});
						branch = unpacked.branch;
						return join(unpacked.dir, work.sub);
					}
					if (repo) {
						const sub = join(repo, work?.sub ?? "");
						return existsSync(sub) ? sub : repo;
					}
					return (
						[input.cwd, mainCheckoutOf(input.cwd)].find(
							(path) => path && existsSync(path),
						) ?? homedir()
					);
				};
				try {
					const { cwd, work } = await withAwsSignIn(host, () =>
						bringSessionHome(host, input.sessionId, placeIn),
					);
					return { cwd, note: movedNote(cwd, work, branch), offline: false };
				} catch (err) {
					// The way out for a stuck host can't need the host: move the mirror.
					const cwd = await bringMirrorHome(input.sessionId, placeIn);
					if (!cwd) throw err;
					return { cwd, note: unreachableNote(cwd), offline: true };
				}
			}),

		/** Done on a remote session: its tmux session on the host ends too. */
		endSession: publicProcedure
			.input(z.object({ sessionId: z.string().min(1) }))
			.mutation(async ({ input }) => {
				const host = readOdinConfig().remoteHost;
				if (!host) return;
				await withAwsSignIn(host, () => endHostSession(host, input.sessionId));
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
			.query(async ({ input }) => {
				const config = readOdinConfig();
				const host = config.remoteHost;
				if (!host?.on) return null;
				const needs = input.source ? CONNECTOR_OF[input.source] : undefined;
				if (needs && !host.connectors?.includes(needs)) return null;
				// A repo owned by a GitHub account kept off the host stays here.
				if (input.repoPath) {
					const origin =
						(await originOf(input.repoPath)) ??
						(await originOf(mainCheckoutOf(input.repoPath)));
					if (repoStaysLocal(config, githubOwner(origin ?? ""))) return null;
				}
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
					/** Quit the host's Claude and start it again, not reattach. */
					fresh: z.boolean().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				// Not gated on `on`: that switch picks where new sessions start,
				// and a session already on the host resumes there either way.
				const host = readOdinConfig().remoteHost;
				if (!host) throw new Error("No remote host is set up.");
				const session = await buildSessionSpec(host, input);
				const spec = Buffer.from(JSON.stringify(session)).toString("base64");
				const ticket = issueTicket(
					await sessionSecrets(githubOwner(session.cloneUrl ?? "")),
				);
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
