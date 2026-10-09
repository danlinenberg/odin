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
 *    "Odin Local Signing" cert - every update would be rejected as signed by a
 *    stranger. Stable signing means putting a p12 in a GitHub secret.
 *  - A Squirrel feed needs latest-mac.yml plus the mac .zip; release.yml
 *    publishes only Odin-arm64.dmg.
 *
 * So this does what the Homebrew cask does, from inside the app: read the
 * latest release tag, download the DMG, mount it, and swap the bundle once the
 * UI has quit. No signature pinning, nothing to add to the release.
 *
 * Windows does the same with the NSIS installer: download it, quit, and run it
 * silently with the flags electron-updater uses, which reopen Odin after.
 */

const REPO_SLUG = "danlinenberg/odin";
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
// release.yml keeps these asset names stable (the cask resolves the DMG's).
const ASSET_NAME = PLATFORM.IS_WINDOWS
	? "Odin-Setup-x64.exe"
	: "Odin-arm64.dmg";

const UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60; // 1 hour

/** The installed bundle - usually /Applications/Odin.app, wherever it lives. */
function appBundlePath(): string {
	// .../Odin.app/Contents/MacOS/Odin -> .../Odin.app
	return dirname(dirname(dirname(app.getPath("exe"))));
}

/** Updates only make sense for a packaged build; `bun dev` has git. */
function canUpdate(): boolean {
	return app.isPackaged && (PLATFORM.IS_MAC || PLATFORM.IS_WINDOWS);
}

export type { AutoUpdateStatusEvent } from "shared/auto-update";

export const autoUpdateEmitter = new EventEmitter();

// Transient/expected failures - no error state, no dialog, just retry later.
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
/** The newest release's download for this platform, once a check found it. */
let availableUrl: string | undefined;
/**
 * A download waiting for the restart that installs it. path is the mounted
 * DMG on macOS and the installer .exe on Windows.
 */
let staged: { version: string; workDir: string; path: string } | undefined;

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

	if (isDismissed && isOffer(status)) {
		return;
	}

	const event: AutoUpdateStatusEvent = { status, version, error, progress };
	autoUpdateEmitter.emit("status-changed", event);
}

/** The states that ask the user to update - the ones "Later" hides. */
function isOffer(status: AutoUpdateStatus): boolean {
	return (
		status === AUTO_UPDATE_STATUS.AVAILABLE ||
		status === AUTO_UPDATE_STATUS.READY
	);
}

export function getUpdateStatus(): AutoUpdateStatusEvent {
	if (isDismissed && isOffer(currentStatus)) {
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

/**
 * The newest published release and this platform's download, or null when
 * the tag isn't a version or the asset isn't uploaded yet (release.yml adds
 * the Windows installer some minutes after it publishes the release).
 */
async function fetchLatestRelease(): Promise<{
	version: string;
	url: string;
} | null> {
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
	const release = (await response.json()) as {
		tag_name?: string;
		assets?: { name: string; browser_download_url: string }[];
	};
	const version = release.tag_name?.replace(/^v/, "");
	const url = release.assets?.find(
		(asset) => asset.name === ASSET_NAME,
	)?.browser_download_url;
	return version && valid(version) && url ? { version, url } : null;
}

const PROGRESS_EMIT_INTERVAL_MS = 500;

/**
 * Download the release asset. On macOS mount the DMG and return the mounted
 * Odin.app's dir; on Windows return the installer's path.
 */
async function downloadRelease(
	version: string,
	url: string,
): Promise<{ path: string; workDir: string }> {
	const workDir = await mkdtemp(join(tmpdir(), "odin-update-"));
	const filePath = join(workDir, ASSET_NAME);
	const mountPoint = join(workDir, "mnt");

	const response = await fetch(url, {
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
	await pipeline(body, createWriteStream(filePath));
	log.info(
		`[auto-updater] Downloaded ${transferredBytes} bytes to ${filePath}`,
	);
	if (PLATFORM.IS_WINDOWS) return { path: filePath, workDir };

	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"/usr/bin/hdiutil",
			["attach", filePath, "-nobrowse", "-readonly", "-mountpoint", mountPoint],
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
	return { path: mountPoint, workDir };
}

/** Download (unless already staged), then quit and swap. Only a click calls this. */
export async function installUpdate(): Promise<void> {
	if (isInstalling || isChecking) {
		log.info("[auto-updater] Install already in progress");
		return;
	}
	if (!staged) {
		if (
			currentStatus !== AUTO_UPDATE_STATUS.AVAILABLE ||
			!currentVersion ||
			!availableUrl
		) {
			log.warn(
				`[auto-updater] Install ignored: nothing available (${currentStatus})`,
			);
			return;
		}
		const version = currentVersion;
		const url = availableUrl;
		isChecking = true;
		try {
			emitStatus(AUTO_UPDATE_STATUS.DOWNLOADING, version);
			staged = { version, ...(await downloadRelease(version, url)) };
			emitStatus(AUTO_UPDATE_STATUS.READY, version);
		} catch (error) {
			log.error("[auto-updater] Download failed:", error);
			// Back to the offer, so the banner's button can try again.
			emitStatus(AUTO_UPDATE_STATUS.AVAILABLE, version, errorMessage(error));
			return;
		} finally {
			isChecking = false;
		}
	}
	isInstalling = true;
	log.info(`[auto-updater] Installing ${staged.version} and relaunching`);
	// The NSIS installer waits for Odin to exit (and closes it if it lingers).
	// These are electron-updater's flags: --updated keeps the user's shortcuts,
	// /S runs it silently, --force-run reopens Odin when it's done.
	const child = PLATFORM.IS_WINDOWS
		? spawn(staged.path, ["--updated", "/S", "--force-run"], {
				detached: true,
				stdio: "ignore",
			})
		: spawn(
				"/bin/bash",
				[
					"-c",
					swapScript({
						appBundle: appBundlePath(),
						workDir: staged.workDir,
						mountPoint: staged.path,
					}),
				],
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
					? "In-app updates are only available on macOS and Windows."
					: "This is a development build - update it with scripts/odin-update.sh.",
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
		if (userAsked) await offerUpdate(staged.version);
		return;
	}

	isChecking = true;
	isDismissed = false;
	emitStatus(AUTO_UPDATE_STATUS.CHECKING);
	try {
		const release = await fetchLatestRelease();
		const latest = release?.version;
		if (!release || !latest || !gt(latest, app.getVersion())) {
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
		// Announce only - the renderer's banner downloads and installs on a
		// click. Nothing updates on its own.
		availableUrl = release.url;
		emitStatus(AUTO_UPDATE_STATUS.AVAILABLE, latest);
		if (userAsked) await offerUpdate(latest);
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

/** Menu/tray "Check for Updates" asked, so answer with a choice. */
async function offerUpdate(version: string): Promise<void> {
	const { response } = await dialog.showMessageBox({
		type: "info",
		title: "Update Available",
		message: `Odin ${version} is available.`,
		detail: PLATFORM.IS_WINDOWS
			? "Odin will download it, quit, install it and reopen. Running sessions end when Odin quits."
			: "Odin will download it, quit, swap itself out and reopen. Open terminal sessions survive.",
		buttons: ["Update Now", "Later"],
		defaultId: 0,
		cancelId: 1,
	});
	if (response === 0) await installUpdate();
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
		`[auto-updater] Initialized: version=${app.getVersion()}, exe=${app.getPath("exe")}`,
	);

	// The background check only announces: UpdateBanner in the renderer shows
	// the offer and its button is the only thing that installs.
	const interval = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
	interval.unref();
	app
		.whenReady()
		.then(() => checkForUpdates())
		.catch((error) => {
			log.error("[auto-updater] Failed to start update checks:", error);
		});
}
