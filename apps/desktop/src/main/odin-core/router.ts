import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "lib/trpc";
import { createBacklogReviewRouter } from "lib/trpc/routers/backlog-review";
import { createConnectionsRouter } from "lib/trpc/routers/connections";
import { createNotionRouter } from "lib/trpc/routers/notion";
import { createSlackRouter } from "lib/trpc/routers/slack";
import { claudeAuthProcedures } from "lib/trpc/routers/system";
import { createWorkRouter } from "lib/trpc/routers/work";
import { createWorkLogRouter } from "lib/trpc/routers/work-log";
import { completeJiraOAuth, isJiraOAuthCallback } from "main/lib/jira-oauth";
import {
	completeNotionOAuth,
	isNotionOAuthCallback,
} from "main/lib/notion-oauth";
import { completeSlackOAuth, isSlackOAuthCallback } from "main/lib/slack-oauth";
import type { REMOTE_CORE_NAMESPACES } from "shared/remote-core";
import { z } from "zod";
import { enqueueFromLaptop, serverLaunchBlocker } from "./launcher";
import { readStateEntry, writeStateEntry } from "./state-store";

/**
 * Odin's connections, served by the remote host-service while the laptop is
 * a front end: the same desktop routers, running on the server against the
 * server's odin.json (its own credentials and token refresh) and local DB.
 * The renderer sends these namespaces here in remote mode
 * (renderer/lib/remote-core-link.ts).
 */
export function createOdinCoreRouter() {
	const routers = {
		connections: createConnectionsRouter(),
		work: createWorkRouter(),
		slack: createSlackRouter(),
		notion: createNotionRouter(),
		backlogReview: createBacklogReviewRouter(),
		workLog: createWorkLogRouter(),
	} satisfies Record<(typeof REMOTE_CORE_NAMESPACES)[number], unknown>;
	return router({
		...routers,
		/** Claude's sign-in on this server, where sessions run (REMOTE_CORE_PROCEDURES). */
		system: router(claudeAuthProcedures),
		/** The window's stores, mirrored for the server's schedulers (state-store.ts). */
		state: router({
			get: publicProcedure
				.input(z.object({ keys: z.array(z.string()).max(100) }))
				.query(({ input }) =>
					Object.fromEntries(
						input.keys.map((key) => [key, readStateEntry(key)]),
					),
				),
			set: publicProcedure
				.input(
					z.object({
						key: z.string(),
						value: z.string().max(5_000_000),
						updatedAt: z.number(),
					}),
				)
				.mutation(({ input }) => {
					// The server's own bookkeeping is never written from outside.
					if (input.key.startsWith("server:")) {
						throw new TRPCError({
							code: "FORBIDDEN",
							message: "server: keys are written by the server only",
						});
					}
					const current = readStateEntry(input.key);
					// An older copy (a laptop that was offline) never wins.
					if (current && current.updatedAt > input.updatedAt) {
						return { applied: false, current };
					}
					writeStateEntry(input.key, {
						value: input.value,
						updatedAt: input.updatedAt,
					});
					return { applied: true, current: null };
				}),
		}),
		/**
		 * The launch gate and queue, run on the server: the window asks here
		 * whether a launch must wait (this machine's load, not the laptop's), and
		 * hands its queued tasks over so they start with the laptop shut.
		 */
		launcher: router({
			blocker: publicProcedure
				.input(
					z.object({ checkout: z.string(), except: z.string().optional() }),
				)
				.query(({ input }) =>
					serverLaunchBlocker(input.checkout, input.except),
				),
			enqueue: publicProcedure
				.input(
					z.object({
						paneId: z.string().min(1),
						tabId: z.string().min(1),
						sessionId: z.string(),
						cwd: z.string().min(1),
						checkout: z.string(),
						title: z.string(),
						tags: z.array(z.string()),
						command: z.string().min(1),
						reason: z.string(),
					}),
				)
				.mutation(({ input }) => {
					const { command, reason, ...card } = input;
					enqueueFromLaptop({
						...card,
						brief: null,
						contact: null,
						pageId: null,
						queued: { command, reason },
					});
					return { queued: true };
				}),
		}),
		/**
		 * A sign-in started here comes back to the laptop as an odin:// deep
		 * link; the laptop forwards it, and the code is exchanged here, where
		 * the sign-in's state and the client secret are.
		 */
		oauth: router({
			complete: publicProcedure
				.input(z.object({ url: z.string().min(1) }))
				.mutation(async ({ input }) => {
					if (isSlackOAuthCallback(input.url)) {
						await completeSlackOAuth(input.url);
					} else if (isNotionOAuthCallback(input.url)) {
						await completeNotionOAuth(input.url);
					} else if (isJiraOAuthCallback(input.url)) {
						await completeJiraOAuth(input.url);
					} else {
						return { handled: false };
					}
					return { handled: true };
				}),
		}),
	});
}

export type OdinCoreRouter = ReturnType<typeof createOdinCoreRouter>;
