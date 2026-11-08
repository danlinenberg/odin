import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { app, dialog } from "electron";
import { quitApp } from "main/index";
import { getDaemonTerminalManager, restartDaemon } from "main/lib/terminal";
import { signedUnlike } from "main/lib/terminal-host/parked-bundle";

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
	if (response === 0) await restartCompletely();
}

async function restartCompletely(): Promise<void> {
	await restartDaemon().catch((error) =>
		console.error("[restart] Terminal daemon restart failed:", error),
	);
	restartOdin();
}

/** Sessions kept alive across Odin's 1.1.0 signature change re-trigger folder prompts until they restart. */
export async function offerRestartOffOldSignature(): Promise<void> {
	if (process.platform !== "darwin" || !app.isPackaged) return;
	const parked = await getDaemonTerminalManager().parkedBundle();
	const installed = resolve(process.execPath, "../../..");
	if (!parked || !(await signedUnlike(parked, installed))) return;
	const { response } = await dialog.showMessageBox({
		type: "warning",
		buttons: ["Restart Completely", "Later"],
		defaultId: 0,
		cancelId: 1,
		title: "Restart Odin Completely",
		message: "Restart open sessions on this Odin?",
		detail:
			"Your open sessions still run on an older Odin that is signed differently, so macOS keeps asking for access to your folders. Restarting closes every open session. Sessions on the remote host keep running there.",
	});
	if (response === 0) await restartCompletely();
}
