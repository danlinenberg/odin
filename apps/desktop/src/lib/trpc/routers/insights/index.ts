import { slackReactions, workLog } from "@odin/local-db";
import { eq } from "drizzle-orm";
import { BrowserWindow, powerMonitor } from "electron";
import { localDb } from "main/lib/local-db";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { activeProfileId } from "../odin-config";
import { sessionPeople } from "../terminal/session-people";
import { computeInsights } from "./insights";

export const createInsightsRouter = () => {
	return router({
		/**
		 * Arithmetic over rows already on disk — cheap enough to recompute per
		 * call rather than cache. Scoped to the active profile so work numbers
		 * can't be inflated by a personal queue.
		 */
		summary: publicProcedure.query(() => {
			const profileId = activeProfileId();
			const asks = localDb
				.select()
				.from(slackReactions)
				.where(eq(slackReactions.profileId, profileId))
				.all();
			// The ledger predates nothing else here, so a store without its
			// migration must degrade to "no delegations logged", not a 500.
			let delegations: { source: string; startedAt: number }[] = [];
			try {
				delegations = localDb
					.select()
					.from(workLog)
					.where(eq(workLog.profileId, profileId))
					.all();
			} catch (error) {
				console.warn("[insights] work log unreadable:", error);
			}
			return computeInsights(
				asks.map((ask) => ({
					firstSeenAt: ask.firstSeenAt,
					startedAt: ask.startedAt,
					doneAt: ask.doneAt,
					unreactedAt: ask.unreactedAt,
					authorName: ask.authorName,
				})),
				delegations.map((row) => ({
					source: row.source,
					person: null,
					startedAt: row.startedAt,
				})),
			);
		}),

		/**
		 * The long history, read off the transcript store rather than the DB.
		 * The ledger only knows about launches since it landed; `~/.claude`
		 * has every session ever run here, so that's where "how was last month"
		 * is actually answerable.
		 *
		 * Separate from `summary` because it reads files: the counters render
		 * instantly and this fills in behind them. Scans are memoised on
		 * mtime, so only a transcript that changed is re-read.
		 */
		/**
		 * A heartbeat from an open session pane. Only counted when Odin has
		 * focus and you touched the machine in the last two minutes — an open
		 * pane you walked away from isn't your time.
		 */
		attend: publicProcedure
			.input(z.object({ sessionId: z.string().min(1) }))
			.mutation(async ({ input }) => {
				if (!BrowserWindow.getFocusedWindow()) return { counted: false };
				if (powerMonitor.getSystemIdleTime() > 120) return { counted: false };
				const { recordBeat } = await import("main/lib/claude-sessions");
				await recordBeat(input.sessionId);
				return { counted: true };
			}),

		workload: publicProcedure
			.input(
				z
					.object({ only: z.string().nullable(), hide: z.array(z.string()) })
					.optional(),
			)
			.query(async ({ input }) => {
				const { cachedBriefs, computeWorkload, scanSessions } = await import(
					"main/lib/claude-sessions"
				);
				const { readAttention } = await import("main/lib/claude-sessions");
				const [sessions, briefs] = await Promise.all([
					readAttention().then((attention) =>
						scanSessions({ people: sessionPeople(), attention }),
					),
					cachedBriefs(),
				]);
				const workload = computeWorkload(sessions, input);
				// A written brief says what a session did, not just what it was
				// asked; use it where the board already paid for one.
				for (const week of workload.recap)
					for (const task of week.tasks) {
						const brief = briefs.get(task.sessionId);
						const said = [brief?.goal, brief?.status]
							.filter(Boolean)
							.join("\n\n");
						if (said) task.description = said;
					}
				return workload;
			}),
	});
};
