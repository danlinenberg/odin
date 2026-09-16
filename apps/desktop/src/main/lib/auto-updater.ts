import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app, dialog } from "electron";
import log from "electron-log/main";
import { setSkipQuitConfirmation } from "main/index";
import { gt, valid } from "semver";
import {
	AUTO_UPDATE_STATUS,
	type AutoUpdateProgress,
	type AutoUpdateStatus,
	type AutoUpdateStatusEvent,
} from "shared/auto-update";
import { PLATFORM } from "shared/constants";
import { swapScript } from "./update-swap-script";

/**
 * In-app updates, so a release can be installed without going back to a
 * terminal for `brew upgrade --cask odin`.
 *
 * NOT electron-updater/Squirrel.Mac, which is what used to sit here (disabled
 * behind an early `return`), for two reasons that both have to be fixed before
 * it could work at all:
 *
 *  - Squirrel validates the downloaded bundle against the *running* app's
 *    designated requirement, which for a self-signed leaf pins the exact
 *    certificate. apps/desktop/scripts/create-signing-identity.sh finds an
 *    empty keychain on every hosted runner, so each Release run mints a fresh
 *    "Odin Local Signing" cert — every update would be rejected as signed by a
 *    stranger. Stable signing means putting a p12 in a GitHub secret.
 *  - A Squirrel feed needs latest-mac.yml plus the mac .zip; release.yml
 *    publishes only Odin-arm64.dmg.
 *
 * So this does what the Homebrew cask does, from inside the app: read the
 * latest release tag, download the DMG, mount it, and swap the bundle once the
 * UI has quit. No signature pinning, nothing to add to the release.
 */

const REPO_SLUG = "danlinenberg/odin";
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
// Same URL the cask resolves; release.yml keeps the asset name stable so that
// /releases/latest/download always points at the newest build.
const DMG_URL = `https://github.com/${REPO_SLUG}/releases/latest/download/Odin-arm64.dmg`;

const UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60 * 4; // 4 hours

/** The installed bundle — usually /Applications/Odin.app, wherever it lives. */
function appBundlePath(): string {
	// .../Odin.app/Contents/MacOS/Odin -> .../Odin.app
	return dirname(dirname(dirname(app.getPath("exe"))));
}

/** Updates only make sense for a packaged macOS build; `bun dev` has git. */
function canUpdate(): boolean {
	return app.isPackaged && PLATFORM.IS_MAC;
}

export type { AutoUpdateStatusEvent } from "shared/auto-update";

export const autoUpdateEmitter = new EventEmitter();

// Transient/expected failures — no error state, no dialog, just retry later.
const SILENT_ERROR_PATTERNS = [
	"ENOTFOUND",
	"ETIMEDOUT",
	"ECONNREFUSED",
	"ECONNRESET",
	"EAI_AGAIN",
	"fetch failed",
];

function isNetworkError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return SILENT_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

let currentStatus: AutoUpdateStatus = AUTO_UPDATE_STATUS.IDLE;
let currentVersion: string | undefined;
let currentError: string | undefined;
let currentProgress: AutoUpdateProgress | undefined;
let isDismissed = false;
let isInstalling = false;
let isChecking = false;
/** A downloaded, mounted DMG waiting for the restart that installs it. */
let staged:
	| { version: string; mountPoint: string; workDir: string }
	| undefined;

function emitStatus(
	status: AutoUpdateStatus,
	version?: string,
	error?: string,
	progress?: AutoUpdateProgress,
): void {
	currentStatus = status;
	currentVersion = version;
	currentError = error;
	currentProgress = progress;

	if (isDismissed && status === AUTO_UPDATE_STATUS.READY) {
		return;
	}

	const event: AutoUpdateStatusEvent = { status, version, error, progress };
	autoUpdateEmitter.emit("status-changed", event);
}

export function getUpdateStatus(): AutoUpdateStatusEvent {
	if (isDismissed && currentStatus === AUTO_UPDATE_STATUS.READY) {
		return { status: AUTO_UPDATE_STATUS.IDLE };
	}
	return {
		status: currentStatus,
		version: currentVersion,
		error: currentError,
		progress: currentProgress,
	};
}

export function isUpdateReadyToInstall(): boolean {
	return isInstalling || currentStatus === AUTO_UPDATE_STATUS.READY;
}

export function dismissUpdate(): void {
	isDismissed = true;
	autoUpdateEmitter.emit("status-changed", { status: AUTO_UPDATE_STATUS.IDLE });
}

/** The newest published release, or null when the tag isn't a version. */
async function fetchLatestVersion(): Promise<string | null> {
	const response = await fetch(LATEST_RELEASE_API, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": `Odin/${app.getVersion()}`,
		},
	});
	if (!response.ok) {
		throw new Error(
			`GitHub returned ${response.status} for the latest release`,
		);
	}
	const release = (await response.json()) as { tag_name?: string };
	const version = release.tag_name?.replace(/^v/, "");
	return version && valid(version) ? version : null;
}

const PROGRESS_EMIT_INTERVAL_MS = 500;

/** Download the release DMG and mount it. Returns the mounted Odin.app's dir. */
async function downloadAndMount(
	version: string,
): Promise<{ mountPoint: string; workDir: string }> {
	const workDir = await mkdtemp(join(tmpdir(), "odin-update-"));
	const dmgPath = join(workDir, "Odin.dmg");
	const mountPoint = join(workDir, "mnt");

	const response = await fetch(DMG_URL, {
		headers: { "User-Agent": `Odin/${app.getVersion()}` },
	});
	if (!response.ok || !response.body) {
		throw new Error(`Download failed with ${response.status}`);
	}

	const totalBytes = Number(response.headers.get("content-length") ?? 0);
	let transferredBytes = 0;
	let lastProgressEmitAt = 0;
	// Node's fetch hands back a web ReadableStream; fromWeb wants its own
	// structural copy of that type, which the DOM lib's version doesn't satisfy.
	const body = Readable.fromWeb(
		response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
	);
	body.on("data", (chunk: Buffer) => {
		transferredBytes += chunk.length;
		const now = Date.now();
		if (now - lastProgressEmitAt < PROGRESS_EMIT_INTERVAL_MS) return;
		lastProgressEmitAt = now;
		emitStatus(AUTO_UPDATE_STATUS.DOWNLOADING, version, undefined, {
			percent: totalBytes ? (transferredBytes / totalBytes) * 100 : 0,
			transferredBytes,
			totalBytes,
		});
	});
	await pipeline(body, createWriteStream(dmgPath));
	log.info(`[auto-updater] Downloaded ${transferredBytes} bytes to ${dmgPath}`);

	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"/usr/bin/hdiutil",
			["attach", dmgPath, "-nobrowse", "-readonly", "-mountpoint", mountPoint],
			{ stdio: "ignore" },
		);
		child.on("error", reject);
		child.on("exit", (code) =>
			code === 0
				? resolve()
				: reject(new Error(`hdiutil attach exited ${code}`)),
		);
	});

	if (!existsSync(join(mountPoint, "Odin.app"))) {
		throw new Error("The downloaded disk image has no Odin.app in it");
	}
	return { mountPoint, workDir };
}

export function installUpdate(): void {
	if (isInstalling) {
		log.info("[auto-updater] Install already in progress");
		return;
	}
	if (!staged) {
		log.warn(
			`[auto-updater] Install ignored: nothing staged (${currentStatus})`,
		);
		return;
	}
	isInstalling = true;
	log.info(`[auto-updater] Installing ${staged.version} and relaunching`);
	const child = spawn(
		"/bin/bash",
		["-c", swapScript({ appBundle: appBundlePath(), ...staged })],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();
	setSkipQuitConfirmation();
	app.quit();
}

async function runCheck({ userAsked }: { userAsked: boolean }): Promise<void> {
	if (!canUpdate()) {
		if (userAsked) {
			await dialog.showMessageBox({
				type: "info",
				title: "Updates",
				message: app.isPackaged
					? "In-app updates are only available on macOS."
					: "This is a development build — update it with scripts/odin-update.sh.",
			});
		}
		return;
	}
	if (isChecking || isInstalling) return;

	// Already downloaded and mounted: offer the restart again instead of
	// pulling another 280 MB.
	if (staged) {
		isDismissed = false;
		emitStatus(AUTO_UPDATE_STATUS.READY, staged.version);
		await offerRestart(staged.version);
		return;
	}

	isChecking = true;
	isDismissed = false;
	emitStatus(AUTO_UPDATE_STATUS.CHECKING);
	try {
		const latest = await fetchLatestVersion();
		if (!latest || !gt(latest, app.getVersion())) {
			emitStatus(AUTO_UPDATE_STATUS.IDLE);
			log.info(
				`[auto-updater] Up to date (current=${app.getVersion()}, latest=${latest ?? "unknown"})`,
			);
			if (userAsked) {
				await dialog.showMessageBox({
					type: "info",
					title: "No Updates",
					message: "You're up to date!",
					detail: `Version ${app.getVersion()} is the latest version.`,
				});
			}
			return;
		}

		log.info(
			`[auto-updater] Update available: ${app.getVersion()} → ${latest}`,
		);
		const { response } = await dialog.showMessageBox({
			type: "info",
			title: "Update Available",
			message: `Odin ${latest} is available.`,
			detail: `You're on ${app.getVersion()}. Downloading is about 280 MB.`,
			buttons: ["Download", "Later"],
			defaultId: 0,
			cancelId: 1,
		});
		if (response !== 0) {
			emitStatus(AUTO_UPDATE_STATUS.IDLE);
			return;
		}

		emitStatus(AUTO_UPDATE_STATUS.DOWNLOADING, latest);
		staged = { version: latest, ...(await downloadAndMount(latest)) };
		emitStatus(AUTO_UPDATE_STATUS.READY, latest);
		await offerRestart(latest);
	} catch (error) {
		if (isNetworkError(error)) {
			log.info("[auto-updater] Network unavailable, will retry later");
			emitStatus(AUTO_UPDATE_STATUS.IDLE);
			if (userAsked) {
				await dialog.showMessageBox({
					type: "info",
					title: "No Internet Connection",
					message: "Unable to check for updates.",
				});
			}
			return;
		}
		log.error("[auto-updater] Update failed:", error);
		emitStatus(AUTO_UPDATE_STATUS.ERROR, undefined, errorMessage(error));
		if (userAsked) {
			await dialog.showMessageBox({
				type: "error",
				title: "Update Error",
				message: "The update failed.",
				detail: errorMessage(error),
			});
		}
	} finally {
		isChecking = false;
	}
}

async function offerRestart(version: string): Promise<void> {
	const { response } = await dialog.showMessageBox({
		type: "info",
		title: "Update Ready",
		message: `Odin ${version} is ready to install.`,
		detail:
			"Odin will quit, swap itself out and reopen. Open terminal sessions survive.",
		buttons: ["Restart Now", "Later"],
		defaultId: 0,
		cancelId: 1,
	});
	if (response === 0) installUpdate();
}

export function checkForUpdates(): void {
	void runCheck({ userAsked: false });
}

export function checkForUpdatesInteractive(): void {
	void runCheck({ userAsked: true });
}

export function setupAutoUpdater(): void {
	if (!canUpdate()) return;

	log.transports.file.level = "info";
	log.info(
		`[auto-updater] Initialized: version=${app.getVersion()}, bundle=${appBundlePath()}`,
	);

	// ponytail: the background check prompts with a dialog because there is no
	// update UI in the renderer — the trpc autoUpdate router streams the status
	// events for one, if a pill ever wants them.
	const interval = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
	interval.unref();
	app
		.whenReady()
		.then(() => checkForUpdates())
		.catch((error) => {
			log.error("[auto-updater] Failed to start update checks:", error);
		});
}
