import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ODIN_DIR_NAME } from "shared/constants";

// Honor ODIN_HOME_DIR only — the shell exports
// ODIN_HOME_DIR=~/.odin globally, which would silently point Odin at
// the real Odin app's data and daemon. We still WRITE the resolved path
// to ODIN_HOME_DIR so spawned children (daemon, host-service) inherit it.
const ODIN_HOME_DIR_ENV = "ODIN_HOME_DIR";

export const ODIN_HOME_DIR =
	process.env.ODIN_HOME_DIR || join(homedir(), ODIN_DIR_NAME);
process.env[ODIN_HOME_DIR_ENV] = ODIN_HOME_DIR;

export const ODIN_HOME_DIR_MODE = 0o700;
export const ODIN_SENSITIVE_FILE_MODE = 0o600;

export function ensureOdinHomeDirExists(): void {
	if (!existsSync(ODIN_HOME_DIR)) {
		mkdirSync(ODIN_HOME_DIR, {
			recursive: true,
			mode: ODIN_HOME_DIR_MODE,
		});
	}

	// Best-effort repair if the directory already existed with weak permissions.
	try {
		chmodSync(ODIN_HOME_DIR, ODIN_HOME_DIR_MODE);
	} catch (error) {
		console.warn(
			"[app-environment] Failed to chmod Odin home dir (best-effort):",
			ODIN_HOME_DIR,
			error,
		);
	}
}

// For lowdb - use our own path instead of app.getPath("userData")
export const APP_STATE_PATH = join(ODIN_HOME_DIR, "app-state.json");

// Window geometry state (separate from UI state - main process only, sync I/O)
export const WINDOW_STATE_PATH = join(ODIN_HOME_DIR, "window-state.json");
