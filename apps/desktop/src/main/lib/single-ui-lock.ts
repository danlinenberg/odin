import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { ODIN_HOME_DIR, ODIN_HOME_DIR_MODE } from "./app-environment";
import { isProcessAlive } from "./host-service-manifest";

/**
 * One UI per `$ODIN_HOME_DIR`, across bundle identifiers.
 *
 * `app.requestSingleInstanceLock()` is keyed on the bundle id, so it only stops
 * a second copy of the *same* build. The dev build (`bun dev`) and the packaged
 * app ship different bundle ids while sharing one home dir - so both acquire
 * Electron's lock, both run, and both read and write `app-state.json`. That file
 * holds `tabsState.activeTabIds` and `tabsState.focusedPaneIds`: the session
 * you are currently looking at. Last writer wins, so a background instance
 * silently drags the foreground one off whatever the user was working in.
 *
 * This lock is keyed on the home dir instead, which is the thing actually being
 * shared.
 */
export interface UiLockHolder {
	pid: number;
	/** Bundle id or process name of the holder, for the "already running" message. */
	app: string;
	acquiredAt: number;
}

export type UiLockResult =
	| { ok: true; release: () => void }
	| { ok: false; holder: UiLockHolder | null };

function lockPath(homeDir: string): string {
	return join(homeDir, "ui.lock");
}

function readHolder(homeDir: string): UiLockHolder | null {
	try {
		const data = JSON.parse(readFileSync(lockPath(homeDir), "utf-8"));
		if (typeof data.pid !== "number" || typeof data.app !== "string") {
			return null;
		}
		return data as UiLockHolder;
	} catch {
		return null;
	}
}

function removeLock(homeDir: string): void {
	try {
		unlinkSync(lockPath(homeDir));
	} catch {
		// Already gone - fine.
	}
}

function tryCreateLock(homeDir: string, appId: string): UiLockResult | null {
	try {
		mkdirSync(homeDir, { recursive: true, mode: ODIN_HOME_DIR_MODE });
	} catch {
		// Best-effort; openSync below surfaces a real failure.
	}

	let fd: number;
	try {
		// "wx" = O_CREAT | O_EXCL: atomic exclusive create on POSIX and Windows.
		fd = openSync(lockPath(homeDir), "wx", 0o600);
	} catch {
		return null;
	}

	try {
		const holder: UiLockHolder = {
			pid: process.pid,
			app: appId,
			acquiredAt: Date.now(),
		};
		writeSync(fd, JSON.stringify(holder));
	} finally {
		try {
			// Best-effort close; the lock's existence, not the fd, is what matters.
			closeSync(fd);
		} catch {}
	}

	return { ok: true, release: () => removeLock(homeDir) };
}

// Slack for a wall clock that NTP corrects after boot.
const BOOT_CLOCK_SLACK_MS = 60_000;

/** When this computer last booted, in wall-clock ms. */
function bootTime(): number {
	return Date.now() - uptime() * 1000;
}

/**
 * Whether the lock's holder is still the Odin that wrote it. A lock written
 * before the last boot is stale even when its pid is alive: after a reboot the
 * pid belongs to some other process (macOS's `homed`, for one), and checking
 * only that the pid is alive kept Odin from starting at all.
 */
function holderAlive(holder: UiLockHolder, bootedAt: number): boolean {
	if (holder.acquiredAt < bootedAt - BOOT_CLOCK_SLACK_MS) return false;
	return isProcessAlive(holder.pid);
}

/**
 * Claim the home dir for this UI process.
 *
 * A lock left by a *dead* pid, or written before the last boot, is stolen - a
 * SIGKILL or a crash must not lock the user out of their own app. A lock held
 * by a *live* pid since this boot is never stolen, and never times out: an
 * instance the user has had open for a week is still the legitimate owner.
 */
export function acquireSingleUiLock(
	appId: string,
	homeDir: string = ODIN_HOME_DIR,
	bootedAt: number = bootTime(),
): UiLockResult {
	const acquired = tryCreateLock(homeDir, appId);
	if (acquired) return acquired;

	const holder = readHolder(homeDir);
	if (holder && holderAlive(holder, bootedAt)) {
		return { ok: false, holder };
	}

	// Holder is dead, from before the last boot, or the file is garbage from a
	// partial write.
	removeLock(homeDir);
	// One retry; if another starting instance won the race, it owns the dir.
	return (
		tryCreateLock(homeDir, appId) ?? { ok: false, holder: readHolder(homeDir) }
	);
}
