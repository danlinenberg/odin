import { sentFromPhone } from "main/lib/phone/sent";
import {
	phoneStatus,
	removePhone,
	setPhoneEnabled,
	unpairAllPhones,
} from "main/lib/phone/server";
import { z } from "zod";
import { publicProcedure, router } from "..";

/** Settings → Connections → Phone: Odin on your iPhone, end to end encrypted. */
export const createPhoneRouter = () =>
	router({
		status: publicProcedure.query(() => phoneStatus()),
		setEnabled: publicProcedure
			.input(z.object({ enabled: z.boolean() }))
			.mutation(({ input }) => setPhoneEnabled(input.enabled)),
		remove: publicProcedure
			.input(z.object({ key: z.string() }))
			.mutation(({ input }) => removePhone(input.key)),
		unpairAll: publicProcedure.mutation(() => unpairAllPhones()),
		/** What this session got from the phone: the chat marks those messages. */
		fromPhone: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.query(({ input }) => sentFromPhone(input.paneId)),
	});
