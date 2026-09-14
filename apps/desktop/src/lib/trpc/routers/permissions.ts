import { publicProcedure, router } from "..";
import {
	getPermissionStatus,
	requestAccessibility,
	requestAppleEvents,
	requestFullDiskAccess,
} from "./permissions/native-permissions";

export const createPermissionsRouter = () => {
	return router({
		getStatus: publicProcedure.query(() => {
			return getPermissionStatus();
		}),

		requestFullDiskAccess: publicProcedure.mutation(async () => {
			await requestFullDiskAccess();
		}),

		requestAccessibility: publicProcedure.mutation(async () => {
			await requestAccessibility();
		}),

		requestAppleEvents: publicProcedure.mutation(async () => {
			await requestAppleEvents();
		}),
	});
};

export type PermissionsRouter = ReturnType<typeof createPermissionsRouter>;
