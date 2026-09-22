import { workspaces, worktrees } from "@odin/local-db";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { eq } from "drizzle-orm";
import { appState } from "main/lib/app-state";
import { localDb } from "main/lib/local-db";
import { restartDaemon as restartDaemonShared } from "main/lib/terminal";
import {
	isTerminalAttachCanceledError,
	TERMINAL_ATTACH_CANCELED_MESSAGE,
	TERMINAL_SESSION_KILLED_MESSAGE,
	TerminalKilledError,
} from "main/lib/terminal/errors";
import { getTerminalHostClient } from "main/lib/terminal-host/client";
import { getWorkspaceRuntimeRegistry } from "main/lib/workspace-runtime";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { assertWorkspaceUsable } from "../workspaces/utils/usability";
import { resolveTerminalThemeType } from "./theme-type";
import { getWorkspaceTerminalContext, resolveCwd } from "./utils";

const DEBUG_TERMINAL = process.env.ODIN_TERMINAL_DEBUG === "1";
const logger = console;
let createOrAttachCallCounter = 0;

const SAFE_ID = z
	.string()
	.min(1)
	.refine(
		(value) =>
			!value.includes("/") && !value.includes("\\") && !value.includes(".."),
		{ message: "Invalid id" },
	);

/**
 * Terminal router using daemon-backed terminal runtime
 * Sessions are keyed by paneId and linked to workspaces for cwd resolution
 *
 * Environment variables set for terminal sessions:
 * - PATH: Prepends ~/.odin/bin so wrapper scripts intercept agent commands
 * - ODIN_PANE_ID: The pane ID (used by notification hooks, session key)
 * - ODIN_TAB_ID: The tab ID (parent of pane, used by notification hooks)
 * - ODIN_WORKSPACE_ID: The workspace ID (used by notification hooks)
 * - ODIN_WORKSPACE_NAME: The workspace name (used by setup/teardown scripts)
 * - ODIN_WORKSPACE_PATH: The worktree path (used by setup/teardown scripts)
 * - ODIN_ROOT_PATH: The main repo path (used by setup/teardown scripts)
 * - ODIN_PORT: The hooks server port for agent completion notifications
 */
export const createTerminalRouter = () => {
	const registry = getWorkspaceRuntimeRegistry();
	const terminal = registry.getDefault().terminal;
	if (DEBUG_TERMINAL) {
		console.log(
			"[Terminal Router] Using terminal runtime, capabilities:",
			terminal.capabilities,
		);
	}

	return router({
		createOrAttach: publicProcedure
			.input(
				z.object({
					paneId: SAFE_ID,
					requestId: z.string().min(1).optional(),
					joinPending: z.boolean().optional(),
					tabId: z.string(),
					workspaceId: SAFE_ID,
					cols: z.number().optional(),
					rows: z.number().optional(),
					cwd: z.string().optional(),
					command: z.string().trim().min(1).optional(),
					skipColdRestore: z.boolean().optional(),
					allowKilled: z.boolean().optional(),
					themeType: z.enum(["dark", "light"]).optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const callId = ++createOrAttachCallCounter;
				const startedAt = Date.now();
				const {
					paneId,
					requestId,
					joinPending,
					tabId,
					workspaceId,
					cols,
					rows,
					cwd: cwdOverride,
					command,
					skipColdRestore,
					allowKilled,
					themeType,
				} = input;

				const { workspace, workspacePath, rootPath } =
					getWorkspaceTerminalContext(workspaceId);
				if (workspace?.type === "worktree") {
					assertWorkspaceUsable(workspaceId, workspacePath);
				}
				const cwd = resolveCwd(cwdOverride, workspacePath);

				if (DEBUG_TERMINAL) {
					console.log("[Terminal Router] createOrAttach called:", {
						paneId,
						workspaceId,
						workspacePath,
						cwdOverride,
						resolvedCwd: cwd,
						cols,
						rows,
					});
				}

				const resolvedThemeType = resolveTerminalThemeType({
					requestedThemeType: themeType,
					persistedThemeState: appState.data.themeState,
				});

				try {
					const result = await terminal.createOrAttach({
						paneId,
						requestId,
						joinPending,
						tabId,
						workspaceId,
						workspaceName: workspace?.name,
						workspacePath,
						rootPath,
						cwd,
						cols,
						rows,
						command,
						skipColdRestore: skipColdRestore || !!command,
						allowKilled,
						themeType: resolvedThemeType,
					});

					if (DEBUG_TERMINAL) {
						console.log("[Terminal Router] createOrAttach result:", {
							callId,
							paneId,
							isNew: result.isNew,
							wasRecovered: result.wasRecovered,
							durationMs: Date.now() - startedAt,
						});
					}

					return {
						paneId,
						isNew: result.isNew,
						scrollback: result.scrollback,
						wasRecovered: result.wasRecovered,
						// Cold restore fields (for reboot recovery)
						isColdRestore: result.isColdRestore,
						previousCwd: result.previousCwd,
						// Include snapshot for daemon mode (renderer can use for rehydration)
						snapshot: result.snapshot,
					};
				} catch (error) {
					const isKilledError =
						error instanceof TerminalKilledError ||
						(error instanceof Error &&
							error.message === TERMINAL_SESSION_KILLED_MESSAGE);
					const isAttachCanceled = isTerminalAttachCanceledError(error);
					if (isKilledError) {
						if (DEBUG_TERMINAL) {
							console.warn(
								"[Terminal Router] createOrAttach blocked (killed):",
								{
									paneId,
									workspaceId,
								},
							);
						}
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: TERMINAL_SESSION_KILLED_MESSAGE,
						});
					}
					if (isAttachCanceled) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: TERMINAL_ATTACH_CANCELED_MESSAGE,
						});
					}
					if (DEBUG_TERMINAL) {
						console.warn("[Terminal Router] createOrAttach failed:", {
							callId,
							paneId,
							durationMs: Date.now() - startedAt,
							error: error instanceof Error ? error.message : String(error),
						});
					}
					console.error("[Terminal Router] createOrAttach ERROR:", error);
					throw error;
				}
			}),

		cancelCreateOrAttach: publicProcedure
			.input(
				z.object({
					paneId: SAFE_ID,
					requestId: z.string().min(1),
				}),
			)
			.mutation(({ input }) => {
				terminal.cancelCreateOrAttach(input);
				return { success: true };
			}),

		write: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
					data: z.string(),
					throwOnError: z.boolean().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const shouldThrow = input.throwOnError ?? false;
				try {
					terminal.write(input);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : "Write failed";

					// Emit exit instead of error for deleted sessions to prevent toast floods
					if (message.includes("not found or not alive")) {
						terminal.emit(`exit:${input.paneId}`, 0, 15);
						if (shouldThrow) {
							throw new TRPCError({
								code: "BAD_REQUEST",
								message,
							});
						}
						return;
					}

					terminal.emit(`error:${input.paneId}`, {
						error: message,
						code: "WRITE_FAILED",
					});
					if (shouldThrow) {
						throw new TRPCError({
							code: "INTERNAL_SERVER_ERROR",
							message,
						});
					}
				}
			}),

		ackColdRestore: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ input }) => {
				terminal.ackColdRestore(input.paneId);
			}),

		resize: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
					cols: z.number(),
					rows: z.number(),
					seq: z.number().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				terminal.resize(input);
			}),

		signal: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
					signal: z.string().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				terminal.signal(input);
			}),

		kill: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				await terminal.kill(input);
			}),

		detach: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				terminal.detach(input);
			}),

		clearScrollback: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				await terminal.clearScrollback(input);
			}),

		listDaemonSessions: publicProcedure.query(async () => {
			const { sessions } = await terminal.management.listSessions();
			return { sessions };
		}),

		// Odin fork: read a pane's persisted scrollback (survives daemon death /
		// app restart) so the board can show the transcript of a session whose
		// PTY is gone — killed or from a previous run.
		readHistory: publicProcedure
			.input(
				z.object({
					paneId: z.string(),
					workspaceId: z.string(),
					// Tail only (bytes) — the board polls this to read live state.
					tailBytes: z.number().int().positive().optional(),
				}),
			)
			.query(async ({ input }) => {
				const { HistoryReader } = await import("main/lib/terminal-history");
				const reader = new HistoryReader(input.workspaceId, input.paneId);
				if (input.tailBytes) {
					const tail = await reader.readScrollbackTail(input.tailBytes);
					// `size` lets a poller tell "still writing" from "stopped".
					return { scrollback: tail?.text ?? null, size: tail?.size ?? 0 };
				}
				const scrollback = await reader.readScrollback();
				return { scrollback, size: scrollback?.length ?? 0 };
			}),

		/**
		 * Odin fork: find the Claude Code conversation id for a session we didn't
		 * launch with --session-id (i.e. any session started before that landed).
		 * Claude stores transcripts at ~/.claude/projects/<cwd-slug>/<id>.jsonl —
		 * pick the newest whose content contains `marker` (the task's prompt/
		 * title), else the newest in that directory.
		 */
		findClaudeSession: publicProcedure
			.input(
				z.object({ cwd: z.string().min(1), marker: z.string().optional() }),
			)
			.query(async ({ input }) => {
				const { readdirSync, statSync, readFileSync, existsSync } =
					await import("node:fs");
				const { join } = await import("node:path");
				const { homedir } = await import("node:os");
				// Claude slugifies the cwd: every "/" and "." becomes "-".
				const dir = join(
					homedir(),
					".claude",
					"projects",
					input.cwd.replace(/[/.]/g, "-"),
				);
				if (!existsSync(dir)) return { sessionId: null };
				const idOf = (file: string) => file.replace(/\.jsonl$/, "");
				const files = readdirSync(dir)
					.filter((file) => file.endsWith(".jsonl"))
					.map((file) => {
						const path = join(dir, file);
						return { file, path, mtime: statSync(path).mtimeMs };
					})
					.sort((a, b) => b.mtime - a.mtime);
				if (files.length === 0) return { sessionId: null };
				if (input.marker) {
					for (const candidate of files.slice(0, 40)) {
						try {
							if (
								readFileSync(candidate.path, "utf-8").includes(input.marker)
							) {
								return { sessionId: idOf(candidate.file) };
							}
						} catch {
							// unreadable transcript — try the next one
						}
					}
				}
				return { sessionId: idOf(files[0].file) };
			}),

		/**
		 * Does Claude still have a transcript for this conversation?
		 *
		 * Pinning `--session-id` at launch is not proof one was ever written: a
		 * board session ran a full turn (its hooks fired), left no transcript,
		 * and Resume then spent a respawn on `claude --resume <id>` only for it
		 * to print "No conversation found with session ID" and exit 1 — a dead
		 * pane and no explanation. Ask first. By id across every project, not by
		 * cwd: a pane whose terminal was never opened has no confirmed cwd, and
		 * that is exactly the pane this happened to.
		 */
		claudeSessionExists: publicProcedure
			.input(z.object({ sessionId: z.string().min(1) }))
			.query(async ({ input }) => {
				const { transcriptOf } = await import("main/lib/claude-sessions");
				return { exists: (await transcriptOf(input.sessionId)) !== null };
			}),

		/**
		 * Odin fork: keyword search over Claude Code's own transcripts, so an old
		 * session can be found by what was said in it — the board's card titles
		 * ("Work on Odin", twenty times over) can't do that. Empty query = browse
		 * the newest sessions.
		 *
		 * Who asked is joined in from Odin's own records (see sessionPeople), so
		 * a name finds the sessions that came from that person's Slack message,
		 * ticket or PR — the name is in none of those transcripts.
		 */
		searchClaudeSessions: publicProcedure
			.input(
				z.object({
					query: z.string().default(""),
					limit: z.number().int().positive().max(100).default(40),
				}),
			)
			.query(async ({ input }) => {
				const { searchSessions } = await import("main/lib/claude-sessions");
				const { sessionPeople } = await import("./session-people");
				return searchSessions({ ...input, people: sessionPeople() });
			}),

		/**
		 * The conversation behind a session, as readable prose turns. `project` is
		 * optional: a board pane knows the conversation id it launched with but not
		 * the directory Claude filed it under, so the id alone has to be enough.
		 */
		readClaudeTranscript: publicProcedure
			.input(
				z.object({ project: z.string().optional(), sessionId: z.string() }),
			)
			.query(async ({ input }) => {
				const { readTranscript } = await import("main/lib/claude-sessions");
				return readTranscript(input);
			}),

		/**
		 * A written brief of a session — goal, status, what it wants from you —
		 * produced by `claude -p` over the transcript. Cached on the transcript's
		 * mtime in the main process, so polling an idle session is a stat.
		 */
		summarizeClaudeSession: publicProcedure
			.input(z.object({ sessionId: z.string() }))
			.query(async ({ input }) => {
				const { writeBrief } = await import("main/lib/claude-sessions");
				return writeBrief(input);
			}),

		/**
		 * Odin fork: OPEN / MERGED / CLOSED for the PR links the brief found in a
		 * transcript. Keyed by url so the panel can look each one up.
		 */
		pullRequestStates: publicProcedure
			.input(z.object({ urls: z.array(z.string().url()).max(20) }))
			.query(async ({ input }) => {
				const { pullRequestState } = await import("./pr-state");
				const states = await Promise.all(
					input.urls.map((url) => pullRequestState(url)),
				);
				return Object.fromEntries(
					input.urls.map((url, index) => [url, states[index]]),
				);
			}),

		/**
		 * Write briefs for the board's sessions in the background, so opening a
		 * card shows one immediately instead of starting a 15s model call. Returns
		 * at once; the queue drains one session at a time.
		 */
		warmClaudeSessionBriefs: publicProcedure
			.input(z.object({ sessionIds: z.array(z.string()).max(100) }))
			.mutation(async ({ input }) => {
				const { warmBriefs } = await import("main/lib/claude-sessions");
				return warmBriefs(input.sessionIds);
			}),

		killAllDaemonSessions: publicProcedure.mutation(async () => {
			const client = getTerminalHostClient();
			const before = await terminal.management.listSessions();
			const beforeIds = before.sessions.map((s) => s.sessionId);
			console.log(
				"[killAllDaemonSessions] Before kill:",
				beforeIds.length,
				"sessions",
				beforeIds,
			);

			if (beforeIds.length > 0) {
				const results = await Promise.allSettled(
					beforeIds.map((paneId) => terminal.kill({ paneId })),
				);
				for (const [index, result] of results.entries()) {
					if (result.status === "rejected") {
						const paneId = beforeIds[index];
						logger.error(
							`[killAllDaemonSessions] terminal.kill failed for paneId=${paneId}`,
							{
								paneId,
								reason: result.reason,
							},
						);
					}
				}
			}

			// Poll until sessions are actually dead
			const MAX_RETRIES = 10;
			const RETRY_DELAY_MS = 100;
			let remainingCount = before.sessions.length;
			let afterIds: string[] = [];

			for (let i = 0; i < MAX_RETRIES && remainingCount > 0; i++) {
				await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
				const after = await client.listSessions();
				afterIds = after.sessions
					.filter((s) => s.isAlive)
					.map((s) => s.sessionId);
				remainingCount = afterIds.length;

				if (remainingCount > 0) {
					console.log(
						`[killAllDaemonSessions] Retry ${i + 1}/${MAX_RETRIES}: ${remainingCount} sessions still alive`,
						afterIds,
					);
				}
			}

			const killedCount = before.sessions.length - remainingCount;
			console.log(
				"[killAllDaemonSessions] Complete:",
				killedCount,
				"killed,",
				remainingCount,
				"remaining",
				remainingCount > 0 ? afterIds : [],
			);

			return { killedCount, remainingCount };
		}),

		killDaemonSessionsForWorkspace: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.mutation(async ({ input }) => {
				const { sessions } = await terminal.management.listSessions();
				const toKill = sessions.filter(
					(session) => session.workspaceId === input.workspaceId,
				);

				if (toKill.length > 0) {
					const paneIds = toKill.map((session) => session.sessionId);
					const results = await Promise.allSettled(
						paneIds.map((paneId) => terminal.kill({ paneId })),
					);
					for (const [index, result] of results.entries()) {
						if (result.status === "rejected") {
							const paneId = paneIds[index];
							logger.error(
								`[killDaemonSessionsForWorkspace] terminal.kill failed for paneId=${paneId}`,
								{
									paneId,
									workspaceId: input.workspaceId,
									reason: result.reason,
								},
							);
						}
					}
				}

				return { killedCount: toKill.length };
			}),

		clearTerminalHistory: publicProcedure.mutation(async () => {
			await terminal.management.resetHistoryPersistence();
			return { success: true };
		}),

		/** Restart daemon to recover from stuck state. Kills all sessions. */
		restartDaemon: publicProcedure.mutation(async () => {
			return restartDaemonShared();
		}),

		getSession: publicProcedure
			.input(z.string())
			.query(async ({ input: paneId }) => {
				return terminal.getSession(paneId);
			}),

		getWorkspaceCwd: publicProcedure
			.input(z.string())
			.query(({ input: workspaceId }) => {
				const workspace = localDb
					.select()
					.from(workspaces)
					.where(eq(workspaces.id, workspaceId))
					.get();
				if (!workspace) {
					return null;
				}

				if (!workspace.worktreeId) {
					return null;
				}

				const worktree = localDb
					.select()
					.from(worktrees)
					.where(eq(worktrees.id, workspace.worktreeId))
					.get();
				return worktree?.path ?? null;
			}),

		stream: publicProcedure
			.input(z.string())
			.subscription(({ input: paneId }) => {
				return observable<
					| { type: "data"; data: string }
					| {
							type: "exit";
							exitCode: number;
							signal?: number;
							reason?: "killed" | "exited" | "error";
					  }
					| { type: "disconnect"; reason: string }
					| { type: "error"; error: string; code?: string }
				>((emit) => {
					if (DEBUG_TERMINAL) {
						console.log(`[Terminal Stream] Subscribe: ${paneId}`);
					}

					let firstDataReceived = false;

					const onData = (data: string) => {
						if (DEBUG_TERMINAL && !firstDataReceived) {
							firstDataReceived = true;
							console.log(
								`[Terminal Stream] First data for ${paneId}: ${data.length} bytes`,
							);
						}
						emit.next({ type: "data", data });
					};

					const onExit = (
						exitCode: number,
						signal?: number,
						reason?: "killed" | "exited" | "error",
					) => {
						// Don't emit.complete() - paneId is reused across restarts, completion would strand listeners
						emit.next({ type: "exit", exitCode, signal, reason });
					};

					const onDisconnect = (reason: string) => {
						emit.next({ type: "disconnect", reason });
					};

					const onError = (payload: { error: string; code?: string }) => {
						emit.next({
							type: "error",
							error: payload.error,
							code: payload.code,
						});
					};

					terminal.on(`data:${paneId}`, onData);
					terminal.on(`exit:${paneId}`, onExit);
					terminal.on(`disconnect:${paneId}`, onDisconnect);
					terminal.on(`error:${paneId}`, onError);

					return () => {
						if (DEBUG_TERMINAL) {
							console.log(`[Terminal Stream] Unsubscribe: ${paneId}`);
						}
						terminal.off(`data:${paneId}`, onData);
						terminal.off(`exit:${paneId}`, onExit);
						terminal.off(`disconnect:${paneId}`, onDisconnect);
						terminal.off(`error:${paneId}`, onError);
					};
				});
			}),
	});
};
