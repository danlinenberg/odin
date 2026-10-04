import { shell } from "electron";
import { backupNow, backupStatus } from "main/lib/backup-data";
import { publicProcedure, router } from "..";

/** Settings → Connections → Backup: the daily iCloud Drive copy of ~/.odin. */
export const createBackupRouter = () =>
	router({
		status: publicProcedure.query(() => backupStatus()),
		run: publicProcedure.mutation(async () => {
			if (!(await backupNow()))
				throw new Error(
					"iCloud Drive is off - turn it on in System Settings → Apple Account → iCloud.",
				);
		}),
		reveal: publicProcedure.mutation(async () => {
			const { path, available } = await backupStatus();
			if (available) await shell.openPath(path);
		}),
	});
