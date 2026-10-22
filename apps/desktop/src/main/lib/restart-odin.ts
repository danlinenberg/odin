import { spawn } from "node:child_process";
import { join } from "node:path";
import { app, dialog } from "electron";
import { quitApp } from "main/index";
import { restartDaemon } from "main/lib/terminal";

/**
 * Quits Odin and opens it again. Dev runs from its checkout, so the dev script
 * starts it again and quits this app by pid first, as the "Restart Odin"
 * button does. Open sessions stay live either way.
 */
export function restartOdin(): void {
	if (process.env.NODE_ENV !== "development") {
		app.relaunch();
		quitApp();
		return;
	}
	spawn("/bin/bash", [join(app.getAppPath(), "../../scripts/odin-dev.sh")], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, ODIN_QUIT_PID: String(process.pid) },
	}).unref();
}

/** Restarts Odin with a fresh terminal daemon: every open session is closed. */
export async function confirmAndRestartCompletely(): Promise<void> {
	const { response } = await dialog.showMessageBox({
		type: "warning",
		buttons: ["Restart Completely", "Cancel"],
		defaultId: 1,
		cancelId: 1,
		title: "Restart Odin Completely",
		message: "Restart Odin and close every open session?",
		detail:
			"Every terminal and session helper starts again on the code Odin runs now. Sessions on the remote host keep running there.",
	});
	if (response !== 0) return;
	await restartDaemon().catch((error) =>
		console.error("[restart] Terminal daemon restart failed:", error),
	);
	restartOdin();
}
