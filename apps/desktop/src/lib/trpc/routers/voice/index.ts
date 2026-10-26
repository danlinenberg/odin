import { readFile } from "node:fs/promises";
import {
	slackDraftCalls,
	transcriptOf,
} from "main/lib/claude-sessions/claude-sessions";
import {
	addVoiceNote,
	learnFromDrafts,
	readVoice,
	setVoiceEnabled,
	setVoiceNotes,
	trainingState,
	trainVoice,
	voicePath,
} from "main/lib/voice-profile";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { slackMySentAfter, slackMySentMessages } from "../slack";

/** Settings > Sessions > Your voice: what Odin learned about how I write. */
export const createVoiceRouter = () =>
	router({
		get: publicProcedure.query(async () => {
			const store = await readVoice();
			return {
				enabled: store.enabled,
				guide: store.guide,
				notes: store.notes,
				samples: store.samples.length,
				updatedAt: store.updatedAt,
				trainedAt: store.trainedAt,
				path: voicePath(),
				...trainingState(),
			};
		}),
		setEnabled: publicProcedure
			.input(z.object({ enabled: z.boolean() }))
			.mutation(({ input }) => setVoiceEnabled(input.enabled)),
		setNotes: publicProcedure
			.input(z.object({ notes: z.array(z.string()) }))
			.mutation(({ input }) => setVoiceNotes(input.notes)),
		/** One correction from a draft in chat ("shorter", "no PR links"). */
		addNote: publicProcedure
			.input(z.object({ note: z.string() }))
			.mutation(({ input }) => addVoiceNote(input.note)),
		/**
		 * "Rewrite it" under a draft: what I would have written instead. Learned
		 * like a draft I rewrote before sending. Answers at once; false while
		 * Your voice is off, so nothing is learned.
		 */
		learnFromRewrite: publicProcedure
			.input(z.object({ draft: z.string(), rewrite: z.string() }))
			.mutation(async ({ input }) => {
				if (!(await readVoice()).enabled) return false;
				void learnFromDrafts([
					{ draft: input.draft, sent: [input.rewrite.trim()] },
				]);
				return true;
			}),
		/** Starts training and answers at once; `get` says when it's done. */
		train: publicProcedure.mutation(() => {
			void trainVoice(() => slackMySentMessages());
		}),
		/**
		 * A session closed: learn from how I rewrote its Slack drafts before
		 * sending them. Answers at once; does nothing while Your voice is off.
		 */
		learnFromSession: publicProcedure
			.input(z.object({ sessionId: z.string() }))
			.mutation(async ({ input }) => {
				if (!(await readVoice()).enabled) return;
				const file = await transcriptOf(input.sessionId);
				if (!file) return;
				// The last draft per conversation: an earlier one was rewritten, not sent.
				const byPlace = new Map(
					slackDraftCalls(await readFile(file.path, "utf-8"))
						.filter((draft) => Number.isFinite(draft.at) && draft.text)
						.map((draft) => [`${draft.channel}:${draft.thread}`, draft]),
				);
				const drafts = [...byPlace.values()];
				if (drafts.length === 0) return;
				void Promise.all(
					drafts.map(async ({ channel, thread, at, text }) => ({
						draft: text,
						// The first few: later ones in a DM are about something else.
						sent: (await slackMySentAfter(channel, thread, at)).slice(0, 3),
					})),
				).then((pairs) => learnFromDrafts(pairs));
			}),
	});
