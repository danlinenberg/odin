import { workLog } from "@odin/local-db";
import { desc, eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { activeProfileId } from "../odin-config";

/** Matches Pane.odinSource, minus the retired "slack" alias. */
const SOURCE = z.enum(["reactions", "jira", "pr", "notion"]);

/** One row per item, so relaunching the same thread doesn't log it twice. */
export function workLogId(source: string, externalId: string): string {
	return `${source}:${externalId}`;
}

export const createWorkLogRouter = () => {
	return router({
		/**
		 * Log that an agent was started on a feed item.
		 *
		 * First launch wins — same rule as slack.markStarted. Re-opening a
		 * session tomorrow must not move `startedAt`, or the ledger stops
		 * answering "how long did this sit before I got to it".
		 */
		record: publicProcedure
			.input(
				z.object({
					source: SOURCE,
					externalId: z.string().min(1),
					externalUrl: z.string().nullish(),
					title: z.string(),
					person: z.string().nullish(),
					cwd: z.string().nullish(),
					sessionId: z.string().nullish(),
				}),
			)
			.mutation(({ input }) => {
				const id = workLogId(input.source, input.externalId);
				localDb
					.insert(workLog)
					.values({
						id,
						source: input.source,
						externalId: input.externalId,
						externalUrl: input.externalUrl ?? null,
						title: input.title,
						person: input.person ?? null,
						profileId: activeProfileId(),
						startedAt: Date.now(),
						cwd: input.cwd ?? null,
						sessionId: input.sessionId ?? null,
					})
					// Relaunch: keep the original startedAt, but take the newer
					// session — the transcript you'd want is the one still running.
					.onConflictDoUpdate({
						target: workLog.id,
						set: {
							sessionId: input.sessionId ?? null,
							cwd: input.cwd ?? null,
						},
					})
					.run();
				return { id };
			}),

		/** The ledger, newest first. Read-only — nothing prunes it. */
		list: publicProcedure
			.input(z.object({ limit: z.number().min(1).max(1000).default(200) }))
			.query(({ input }) =>
				localDb
					.select()
					.from(workLog)
					.where(eq(workLog.profileId, activeProfileId()))
					.orderBy(desc(workLog.startedAt))
					.limit(input.limit)
					.all(),
			),
	});
};
