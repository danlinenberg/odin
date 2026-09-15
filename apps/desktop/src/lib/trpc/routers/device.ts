import { getHostId } from "@odin/shared/host-info";
import { publicProcedure, router } from "..";

export const createDeviceRouter = () => {
	return router({
		getMachineId: publicProcedure.query((): { machineId: string } => {
			return { machineId: getHostId() };
		}),
	});
};
