import {
	readVoice,
	setVoiceEnabled,
	setVoiceNotes,
	trainingState,
	trainVoice,
	voicePath,
} from "main/lib/voice-profile";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { slackMySentMessages } from "../slack";

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
		/** Starts training and answers at once; `get` says when it's done. */
		train: publicProcedure.mutation(() => {
			void trainVoice(() => slackMySentMessages());
		}),
	});
