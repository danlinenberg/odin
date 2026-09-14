import { observable } from "@trpc/server/observable";
import {
	getHostServiceCoordinator,
	type HostServiceStatusEvent,
	isSafeOrganizationId,
} from "main/lib/host-service-coordinator";
import { z } from "zod";
import { publicProcedure, router } from "../..";

const orgInput = z.object({
	organizationId: z.string().refine(isSafeOrganizationId, {
		message: "Invalid organization ID",
	}),
});

export const createHostServiceCoordinatorRouter = () => {
	return router({
		getConnection: publicProcedure.input(orgInput).query(({ input }) => {
			const coordinator = getHostServiceCoordinator();
			return coordinator.getConnection(input.organizationId);
		}),

		// All running local host connections, across every org — used to broadcast
		// workspace-session disposal so a non-active-org workspace's terminals are
		// cleaned up regardless of which org is currently active.
		getConnections: publicProcedure.query(() => {
			const coordinator = getHostServiceCoordinator();
			return coordinator.getConnections();
		}),

		getProcessStatus: publicProcedure.input(orgInput).query(({ input }) => {
			const coordinator = getHostServiceCoordinator();
			return { status: coordinator.getProcessStatus(input.organizationId) };
		}),

		restart: publicProcedure.input(orgInput).mutation(({ input }) => {
			const coordinator = getHostServiceCoordinator();
			return coordinator.restart(input.organizationId);
		}),

		reset: publicProcedure.input(orgInput).mutation(({ input }) => {
			const coordinator = getHostServiceCoordinator();
			return coordinator.reset(input.organizationId);
		}),

		onStatusChange: publicProcedure.subscription(() => {
			return observable<HostServiceStatusEvent>((emit) => {
				const coordinator = getHostServiceCoordinator();
				const handler = (event: HostServiceStatusEvent) => emit.next(event);
				coordinator.on("status-changed", handler);
				return () => coordinator.off("status-changed", handler);
			});
		}),
	});
};
