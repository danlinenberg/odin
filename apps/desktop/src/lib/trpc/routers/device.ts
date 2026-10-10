import { getHostId } from "@odin/shared/host-info";
import { powerSaveBlocker } from "electron";
import { z } from "zod";
import { publicProcedure, router } from "..";

let awakeId: number | null = null;

export const createDeviceRouter = () => {
	return router({
		getMachineId: publicProcedure.query((): { machineId: string } => {
			return { machineId: getHostId() };
		}),
		/** Holds off idle system sleep (the display may still sleep), like `caffeinate -i`. */
		keepAwake: publicProcedure.input(z.boolean()).mutation(({ input }) => {
			if (input && awakeId === null)
				awakeId = powerSaveBlocker.start("prevent-app-suspension");
			if (!input && awakeId !== null) {
				powerSaveBlocker.stop(awakeId);
				awakeId = null;
			}
		}),
	});
};
