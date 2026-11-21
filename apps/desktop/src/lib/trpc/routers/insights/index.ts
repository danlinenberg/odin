import { slackReactions, workLog } from "@odin/local-db";
import { eq } from "drizzle-orm";
import { BrowserWindow, powerMonitor } from "electron";
import { appState } from "main/lib/app-state";
import { cardTitles, rememberCardTitles } from "main/lib/card-titles";
import {
	deliveredPerWeek,
	readKinds,
	type SessionForVerdict,
	suggestKinds,
	writeKinds,
} from "main/lib/deliverables";
import { localDb } from "main/lib/local-db";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { activeProfileId } from "../odin-config";
import { mergedPullRequests } from "../terminal/pr-state";
import { sessionPeople, sessionProfileOf } from "../terminal/session-people";
import { computeInsights } from "./insights";

/** The sessions Insights last read, for Suggest to draw kinds from. */
let lastSessions: SessionForVerdict[] = [];

const kindInput = z.object({
	id: z.string().optional(),
	name: z.string(),
	description: z.string(),
});

export const createInsightsRouter = () => {
	return router({
		/**
		 * Arithmetic over rows already on disk - cheap enough to recompute per
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
					channelId: ask.channelId,
					channelName: ask.channelName,
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
		 * focus and you touched the machine in the last two minutes - an open
		 * pane you walked away from isn't your time.
		 */
		/** Your kinds of deliverable (Insights → Delivered per week). */
		deliverableKinds: publicProcedure.query(() => readKinds()),

		setDeliverableKinds: publicProcedure
			.input(z.array(kindInput).max(8))
			.mutation(({ input }) => writeKinds(input)),

		/** Kinds read off your recent sessions - one small model call. */
		suggestDeliverableKinds: publicProcedure.mutation(() =>
			suggestKinds(lastSessions),
		),

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
				// Same scope as `summary`: only the active profile's sessions.
				const profileId = activeProfileId();
				const profileOfSession = sessionProfileOf();
				const mine = sessions.filter(
					(s) => profileOfSession(s.sessionId) === profileId,
				);
				// Only your merged PRs count - an open or closed one hasn't shipped,
				// and a teammate's isn't yours. Each lands in the week it merged:
				// one opened Thursday and merged Sunday shipped Sunday.
				// Five seconds at most: a PR still being looked up counts on the
				// next refetch instead of holding the whole page on GitHub.
				const merged = await mergedPullRequests(
					mine.flatMap((s) => s.prs),
					undefined,
					5_000,
				);
				const workload = computeWorkload(
					mine.map((s) => {
						const prs = s.prs.filter((url) => merged.has(url));
						return {
							...s,
							prs,
							prAt: prs.map((url) => merged.get(url) ?? null),
						};
					}),
					input,
				);
				// The name the board knew it by - a rename included, and kept after
				// the card closes; else the brief's title, which is rewritten as the
				// session works. The transcript's own title is the fallback.
				rememberCardTitles(appState.data.tabsState.panes ?? {});
				const titles = cardTitles();
				// A written brief says what a session did, not just what it was
				// asked; use it where the board already paid for one.
				for (const week of workload.recap)
					for (const task of week.tasks) {
						const brief = briefs.get(task.sessionId);
						task.title = titles[task.sessionId] || brief?.title || task.title;
						const said = [brief?.goal, brief?.status]
							.filter(Boolean)
							.join("\n\n");
						if (said) task.description = said;
					}
				// Your own kinds of deliverable, judged from those same titles
				// and briefs - see main/lib/deliverables.
				const finished = workload.recap.flatMap((week) =>
					week.tasks.map((task) => ({
						sessionId: task.sessionId,
						title: task.title,
						description: task.description,
						endedAt: task.endedAt,
					})),
				);
				lastSessions = finished;
				const delivered = await deliveredPerWeek(
					workload.weeks.map((week) => week.start),
					finished,
				).catch((error) => {
					console.warn("[insights] deliverables:", error);
					return { kinds: [], weeks: [], judging: 0 };
				});
				return { ...workload, delivered };
			}),
	});
};
