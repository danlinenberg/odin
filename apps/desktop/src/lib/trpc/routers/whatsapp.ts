import {
	linkWhatsApp,
	unlinkWhatsApp,
	whatsAppStatus,
} from "main/lib/whatsapp";
import { publicProcedure, router } from "..";

/** Settings → Connections → WhatsApp: link Odin as a WhatsApp Web device. */
export const createWhatsAppRouter = () =>
	router({
		status: publicProcedure.query(() => whatsAppStatus()),
		link: publicProcedure.mutation(() => linkWhatsApp()),
		unlink: publicProcedure.mutation(() => unlinkWhatsApp()),
	});
