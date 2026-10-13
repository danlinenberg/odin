import {
	connectTelegram,
	disconnectTelegram,
	telegramStatus,
} from "main/lib/telegram";
import { z } from "zod";
import { publicProcedure, router } from "..";

/** Settings → Connections → Telegram: Odin's bot, from a @BotFather token. */
export const createTelegramRouter = () =>
	router({
		status: publicProcedure.query(() => telegramStatus()),
		connect: publicProcedure
			.input(z.object({ token: z.string().min(1) }))
			.mutation(({ input }) => connectTelegram(input.token)),
		disconnect: publicProcedure.mutation(() => disconnectTelegram()),
	});
