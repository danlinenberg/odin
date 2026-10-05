import {
	getDoubleTapModifier,
	recordDoubleTap,
	setDoubleTapModifier,
} from "main/lib/double-tap";
import { DOUBLE_TAP_MODIFIERS } from "shared/double-tap-keys";
import { z } from "zod";
import { publicProcedure, router } from "..";

export const createDoubleTapRouter = () => {
	return router({
		get: publicProcedure.query(() => getDoubleTapModifier()),
		/** null turns it off. */
		set: publicProcedure
			.input(z.object({ modifier: z.enum(DOUBLE_TAP_MODIFIERS).nullable() }))
			.mutation(({ input }) => setDoubleTapModifier(input.modifier)),
		/** Resolves with the next modifier you double-tap, already saved. */
		record: publicProcedure.mutation(() => recordDoubleTap()),
	});
};
