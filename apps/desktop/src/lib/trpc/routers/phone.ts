import { sentFromPhone } from "main/lib/phone/sent";
import {
	phoneStatus,
	removePhone,
	setPhoneEnabled,
	unpairAllPhones,
} from "main/lib/phone/server";
import { z } from "zod";
import { publicProcedure, router } from "..";
import { readOdinConfig, updateOdinConfig } from "./odin-config";

/** Settings → Remote → Phone: Odin on your iPhone, end to end encrypted. */
export const createPhoneRouter = () =>
	router({
		status: publicProcedure.query(() => phoneStatus()),
		setEnabled: publicProcedure
			.input(z.object({ enabled: z.boolean() }))
			.mutation(({ input }) => setPhoneEnabled(input.enabled)),
		remove: publicProcedure
			.input(z.object({ key: z.string() }))
			.mutation(({ input }) => removePhone(input.key)),
		unpairAll: publicProcedure.mutation(async () => {
			const status = await unpairAllPhones();
			// The remote host's phones too, without holding Settings up on SSM.
			const host = readOdinConfig().remoteHost;
			if (host)
				void import("main/lib/remote-host/phone-host-sync")
					.then(({ unpairPhoneHost }) => unpairPhoneHost(host))
					.catch((error) => console.warn("[phone-host] unpair:", error));
			return status;
		}),
		/** The remote host paired phones reach too; null while none is set up. */
		remoteHost: publicProcedure.query(() => {
			const host = readOdinConfig().remoteHost;
			return host ? { name: host.name || host.instanceId } : null;
		}),
		/** The board's hand-added tags, so the phone's cards show them too. */
		setCustomTags: publicProcedure
			.input(z.object({ tags: z.array(z.string()).max(200) }))
			.mutation(({ input }) => {
				const current = readOdinConfig().customTags ?? [];
				if (current.join("\n") !== input.tags.join("\n"))
					updateOdinConfig({
						customTags: input.tags.length ? input.tags : undefined,
					});
			}),
		/** What this session got from the phone: the chat marks those messages. */
		fromPhone: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.query(({ input }) => sentFromPhone(input.paneId)),
	});
