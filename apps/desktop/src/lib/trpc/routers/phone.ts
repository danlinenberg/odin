import {
	phoneStatus,
	resetPhoneToken,
	setPhoneEnabled,
} from "main/lib/phone/server";
import { z } from "zod";
import { publicProcedure, router } from "..";

/** Settings → Connections → Phone: Odin on your iPhone over this Wi-Fi. */
export const createPhoneRouter = () =>
	router({
		status: publicProcedure.query(() => phoneStatus()),
		setEnabled: publicProcedure
			.input(z.object({ enabled: z.boolean() }))
			.mutation(({ input }) => setPhoneEnabled(input.enabled)),
		resetToken: publicProcedure.mutation(() => resetPhoneToken()),
	});
