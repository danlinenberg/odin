import { shell } from "electron";
import {
	BACKUP_DIR,
	backupEnabled,
	backupNow,
	backupOff,
	backupStatus,
} from "main/lib/backup-data";
import { publicProcedure, router } from "..";

/** Settings → Connections → Backup: the daily iCloud Drive copy of ~/.odin. */
export const createBackupRouter = () =>
	router({
		// Not turned on yet: report nothing rather than look in iCloud Drive,
		// which would show macOS's access prompt just for opening Settings.
		status: publicProcedure.query(() =>
			backupEnabled()
				? backupStatus()
				: { path: BACKUP_DIR, available: true, lastBackupAt: null, days: 0 },
		),
		run: publicProcedure.mutation(async () => {
			if (!(await backupNow()))
				throw new Error(
					"iCloud Drive is off - turn it on in System Settings → Apple Account → iCloud.",
				);
		}),
		disconnect: publicProcedure.mutation(() => backupOff()),
		reveal: publicProcedure.mutation(async () => {
			const { path, available } = await backupStatus();
			if (available) await shell.openPath(path);
		}),
	});
