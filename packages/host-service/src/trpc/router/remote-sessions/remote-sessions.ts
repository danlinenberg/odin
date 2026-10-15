import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { projects, terminalSessions } from "../../../db/schema";
import { getDaemonClient } from "../../../terminal/daemon-client-singleton";
import {
	createTerminalSessionInternal,
	disposeSessionAndWait,
	parseThemeType,
	snapshotSession,
} from "../../../terminal/terminal";
import type { HostServiceContext } from "../../../types";
import { protectedProcedure, router } from "../../index";
import { createFromImportLocal } from "../project/handlers";
import { ensureMainWorkspaceStrict } from "../project/utils/ensure-main-workspace";
import { tryRevParseGitRoot } from "../project/utils/resolve-repo";
import { markClaudeFolderTrusted } from "./claude-trust";

/**
 * The desktop's Claude sessions, run on this host while a laptop is connected
 * over SSH. The desktop keeps its own terminal API and pane ids; this router
 * maps them onto host terminals (terminal id = pane id) so a session lives in
 * the pty-daemon here and keeps running when the laptop sleeps or closes.
 *
 * Unlike the workspace-scoped `terminal` router, callers know only a pane id
 * and a folder: the workspace a session needs is found or created from the
 * folder's repo.
 */

const absolutePath = z
	.string()
	.min(1)
	.refine((value) => isAbsolute(value), { message: "Path must be absolute" });

/** Find or create the project + main workspace for the repo holding `cwd`. */
async function workspaceForFolder(
	ctx: HostServiceContext,
	cwd: string,
): Promise<string> {
	const gitRoot = await tryRevParseGitRoot(cwd);
	if (gitRoot === null) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `${cwd} is not a git repository on the server. Sessions run in a repo there.`,
		});
	}
	const existing = ctx.db.query.projects
		.findFirst({ where: eq(projects.repoPath, gitRoot) })
		.sync();
	if (existing) {
		const workspace = await ensureMainWorkspaceStrict(
			ctx,
			existing.id,
			gitRoot,
		);
		return workspace.id;
	}
	const created = await createFromImportLocal(ctx, {
		name: basename(gitRoot),
		repoPath: gitRoot,
	});
	return created.mainWorkspaceId;
}

/** The workspace a live or past session of this pane belongs to, if any. */
function workspaceOfPane(
	ctx: HostServiceContext,
	paneId: string,
): string | null {
	const row = ctx.db.query.terminalSessions
		.findFirst({
			where: eq(terminalSessions.id, paneId),
			columns: { originWorkspaceId: true },
		})
		.sync();
	return row?.originWorkspaceId ?? null;
}

async function liveDaemonSessions(): Promise<Map<string, number>> {
	const daemon = await getDaemonClient();
	const alive = new Map<string, number>();
	for (const session of await daemon.list()) {
		if (session.alive) alive.set(session.id, session.pid);
	}
	return alive;
}

export const remoteSessionsRouter = router({
	/**
	 * Attach to a pane's live session, or start one: running `command` if
	 * given, else an interactive shell. Same contract as the desktop daemon's
	 * createOrAttach - a live session wins over a command, so callers that
	 * want a fresh run kill the pane first.
	 */
	open: protectedProcedure
		.input(
			z.object({
				paneId: z.string().min(1),
				tabId: z.string().min(1),
				cwd: absolutePath.optional(),
				command: z.string().min(1).optional(),
				cols: z.number().int().positive().optional(),
				rows: z.number().int().positive().optional(),
				themeType: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const alive = await liveDaemonSessions();
			const knownWorkspace = workspaceOfPane(ctx, input.paneId);

			if (alive.has(input.paneId) && knownWorkspace) {
				const adopted = await createTerminalSessionInternal({
					terminalId: input.paneId,
					workspaceId: knownWorkspace,
					db: ctx.db,
					eventBus: ctx.eventBus,
					adoptOnly: true,
					// Only reached when this host-service restarted under a live
					// session: the laptop has no scrollback for it, so replay.
					replayOnAdoption: true,
					themeType: parseThemeType(input.themeType),
				});
				if ("error" in adopted) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: adopted.error,
					});
				}
				return {
					status: "attached" as const,
					workspaceId: knownWorkspace,
					isNew: false,
				};
			}

			// No live session: start one - the command if given, else an
			// interactive shell (the desktop daemon's attach does the same).
			let workspaceId: string;
			if (input.cwd) {
				workspaceId = await workspaceForFolder(ctx, input.cwd);
			} else if (knownWorkspace) {
				workspaceId = knownWorkspace;
			} else {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "A new session needs a folder on the server to run in.",
				});
			}
			// A pane restarting its session (resume, Start over) reuses its id;
			// the previous run's row must not pin it to another workspace.
			if (knownWorkspace && knownWorkspace !== workspaceId) {
				ctx.db
					.delete(terminalSessions)
					.where(
						and(
							eq(terminalSessions.id, input.paneId),
							eq(terminalSessions.originWorkspaceId, knownWorkspace),
						),
					)
					.run();
			}
			// The folder was opened as a project in Odin; don't let Claude stop
			// on its trust prompt with nobody there to answer it.
			if (input.command && input.cwd) {
				await markClaudeFolderTrusted(input.cwd).catch((error) =>
					console.warn("[remote-sessions] could not pre-trust folder:", error),
				);
			}
			const created = await createTerminalSessionInternal({
				terminalId: input.paneId,
				tabId: input.tabId,
				workspaceId,
				db: ctx.db,
				eventBus: ctx.eventBus,
				command: input.command,
				cwd: input.cwd,
				cols: input.cols,
				rows: input.rows,
				themeType: parseThemeType(input.themeType),
			});
			if ("error" in created) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: created.error,
				});
			}
			return { status: "created" as const, workspaceId, isNew: true };
		}),

	/**
	 * Every live pane session with the last agent state its hooks reported, so
	 * a laptop coming back after hours closed can redraw the board from what
	 * actually happened here.
	 */
	list: protectedProcedure.query(async ({ ctx }) => {
		const alive = await liveDaemonSessions();
		const rows = ctx.db.query.terminalSessions
			.findMany({ where: eq(terminalSessions.status, "active") })
			.sync();
		const sessions = [];
		for (const row of rows) {
			const pid = alive.get(row.id);
			// A killed session can linger in the daemon for a moment after the
			// kill returns; it is gone as far as the board is concerned.
			if (pid === undefined || !row.originWorkspaceId || row.disposeRequestedAt)
				continue;
			const binding = ctx.terminalAgentStore.get(row.id);
			sessions.push({
				paneId: row.id,
				workspaceId: row.originWorkspaceId,
				pid,
				createdAt: row.createdAt,
				lastAttachedAt: row.lastAttachedAt ?? null,
				lastEventType: binding?.lastEventType ?? null,
				lastEventAt: binding?.lastEventAt ?? null,
			});
		}
		return { sessions };
	}),

	/** The pane's screen as plain text (board status scan, readScreen). */
	snapshot: protectedProcedure
		.input(
			z.object({
				paneId: z.string().min(1),
				maxLines: z.number().int().positive().optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const workspaceId = workspaceOfPane(ctx, input.paneId);
			if (!workspaceId) return null;
			const result = await snapshotSession({
				terminalId: input.paneId,
				workspaceId,
				maxLines: input.maxLines,
				db: ctx.db,
				eventBus: ctx.eventBus,
			});
			if ("error" in result) return null;
			const { success: _success, ...snapshot } = result;
			return snapshot;
		}),

	kill: protectedProcedure
		.input(z.object({ paneId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			if (!workspaceOfPane(ctx, input.paneId)) return { killed: false };
			await disposeSessionAndWait(input.paneId, ctx.db);
			ctx.terminalAgentStore.markTerminalExited(input.paneId);
			return { killed: true };
		}),

	/**
	 * What the desktop needs to open a folder as a project here: whether it
	 * exists and which repo it belongs to.
	 */
	pathInfo: protectedProcedure
		.input(z.object({ path: absolutePath }))
		.query(async ({ input }) => {
			const info = await stat(input.path).catch(() => null);
			if (!info) {
				return { exists: false, isDirectory: false, gitRoot: null };
			}
			const gitRoot = info.isDirectory()
				? await tryRevParseGitRoot(input.path)
				: null;
			return { exists: true, isDirectory: info.isDirectory(), gitRoot };
		}),

	mkdir: protectedProcedure
		.input(z.object({ path: absolutePath }))
		.mutation(async ({ input }) => {
			await mkdir(input.path, { recursive: true });
			return { success: true as const };
		}),

	/** Session files the desktop writes into a repo (task prompt, rules, attachments). */
	writeFile: protectedProcedure
		.input(
			z.object({
				path: absolutePath,
				contentBase64: z.string(),
			}),
		)
		.mutation(async ({ input }) => {
			await mkdir(dirname(input.path), { recursive: true });
			await writeFile(input.path, Buffer.from(input.contentBase64, "base64"));
			return { success: true as const };
		}),
});
