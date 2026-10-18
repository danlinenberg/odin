import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { app, safeStorage } from "electron";
import { githubAccessToken } from "main/lib/github-token";
import {
	findClaude,
	listAwsProfiles,
	listInstances,
	listTagChoices,
	startInstance,
} from "main/lib/remote-host/aws-instances";
import {
	httpsCloneUrl,
	issueTicket,
	secretsFile,
	sh,
} from "main/lib/remote-host/session";
import { resolveElectronBinary } from "main/lib/terminal-host/electron-binary";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { readOdinConfig, updateOdinConfig } from "../odin-config";

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
 * Sessions on an EC2 instance the user created: pick it by tags, and the
 * board's sessions run there in tmux, on the user's own Claude plan.
 */
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
		awsFindClaude: publicProcedure
			.input(
				awsTarget.extend({
					id: z.string().min(1),
					user: z.string().min(1),
				}),
			)
			.mutation(async ({ input }) => ({
				path: await findClaude(input, input.id, input.user),
			})),

		/** The host sessions start on; `on: false` keeps them on this computer. */
		get: publicProcedure.query(() => ({
			host: readOdinConfig().remoteHost ?? null,
			hasClaudeToken: Boolean(claudeToken()),
		})),
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
			.mutation(({ input }) => {
				updateOdinConfig({ remoteHost: input });
			}),
		setOn: publicProcedure.input(z.boolean()).mutation(({ input }) => {
			const host = readOdinConfig().remoteHost;
			if (host) updateOdinConfig({ remoteHost: { ...host, on: input } });
		}),
		/** Paste of `claude setup-token`'s output; empty clears it. */
		setClaudeToken: publicProcedure
			.input(z.string().trim())
			.mutation(({ input }) => {
				if (input && !safeStorage.isEncryptionAvailable()) {
					throw new Error("This computer can't encrypt the token.");
				}
				updateOdinConfig({
					claudeToken: input
						? safeStorage.encryptString(input).toString("base64")
						: undefined,
				});
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
				}),
			)
			.mutation(async ({ input }) => {
				const host = readOdinConfig().remoteHost;
				if (!host?.on) throw new Error("No remote host is on.");
				const { repoPath, ...rest } = input;
				const origin = repoPath
					? await promisify(execFile)("git", [
							"-C",
							repoPath,
							"remote",
							"get-url",
							"origin",
						])
							.then(({ stdout }) => httpsCloneUrl(stdout))
							.catch(() => null)
					: null;
				const spec = Buffer.from(
					JSON.stringify({
						...host,
						...rest,
						repoName: repoPath ? basename(repoPath) : null,
						cloneUrl: origin,
					}),
				).toString("base64");
				const ticket = issueTicket(
					secretsFile({
						CLAUDE_CODE_OAUTH_TOKEN: claudeToken() ?? undefined,
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
