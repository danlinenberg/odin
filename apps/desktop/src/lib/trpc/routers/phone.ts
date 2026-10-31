import { TRPCError } from "@trpc/server";
import { sentFromPhone } from "main/lib/phone/sent";
import {
	phoneStatus,
	removePhone,
	setPhoneEnabled,
	unpairAllPhones,
} from "main/lib/phone/server";
import { z } from "zod";
import { publicProcedure, router } from "..";
import { readOdinConfig } from "./odin-config";

/** The remote host set up in Settings, or a clear error. */
function remoteHost() {
	const host = readOdinConfig().remoteHost;
	if (!host)
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Set up a remote host first.",
		});
	return host;
}

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
		/** The remote host Pair phone with remote host pairs with; null while none is set up. */
		remoteHost: publicProcedure.query(() => {
			const host = readOdinConfig().remoteHost;
			return host ? { name: host.name || host.instanceId } : null;
		}),
		/**
		 * The remote host's own pairing QR code: its phone server installed and
		 * started there first, so the phone reaches its sessions with this
		 * computer asleep.
		 */
		hostPairing: publicProcedure.mutation(async () => {
			const { phoneHostPairing } = await import(
				"main/lib/remote-host/phone-host-sync"
			);
			return phoneHostPairing(remoteHost());
		}),
		/** What this session got from the phone: the chat marks those messages. */
		fromPhone: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.query(({ input }) => sentFromPhone(input.paneId)),
	});
