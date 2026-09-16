import path from "node:path";
import { pathToFileURL } from "node:url";
import { settings } from "@odin/local-db";
import {
	app,
	BrowserWindow,
	dialog,
	Notification,
	net,
	protocol,
	session,
	systemPreferences,
} from "electron";
import { makeAppSetup } from "lib/electron-app/factories/app/setup";
import { applyShellEnvToProcess } from "lib/trpc/routers/workspaces/utils/shell-env";
import {
	DEFAULT_CONFIRM_ON_QUIT,
	LOCAL_ORG_ID,
	PLATFORM,
	PROTOCOL_SCHEME,
} from "shared/constants";
import { setupAgentIntegrations } from "./lib/agent-setup";
import { ODIN_HOME_DIR } from "./lib/app-environment";
import { flushAppStateSync, initAppState } from "./lib/app-state";
import { requestAppleEventsAccess } from "./lib/apple-events-permission";
import { isUpdateReadyToInstall, setupAutoUpdater } from "./lib/auto-updater";
import { setWorkspaceDockIcon } from "./lib/dock-icon";
import { loadWebviewBrowserExtension } from "./lib/extensions";
import { getHostServiceCoordinator } from "./lib/host-service-coordinator";
import { completeJiraOAuth, isJiraOAuthCallback } from "./lib/jira-oauth";
import { localDb } from "./lib/local-db";
import { completeNotionOAuth, isNotionOAuthCallback } from "./lib/notion-oauth";
import {
	initTanstackDbPersistence,
	shutdownTanstackDbPersistence,
} from "./lib/persistence/persistence";
import { ensureProjectIconsDir, getProjectIconPath } from "./lib/project-icons";
import { runQuitCleanup } from "./lib/quit-sequence";
import { initSentry } from "./lib/sentry";
import { acquireSingleUiLock } from "./lib/single-ui-lock";
import { completeSlackOAuth, isSlackOAuthCallback } from "./lib/slack-oauth";
import {
	prewarmTerminalRuntime,
	reconcileDaemonSessions,
} from "./lib/terminal";
import {
	disposeTerminalHostClient,
	getTerminalHostClient,
} from "./lib/terminal-host/client";
import { disposeTray, initTray } from "./lib/tray";
import { startNetworkLogger, stopNetworkLogger } from "./network-logger";
import { flushWindowStateSync, MainWindow } from "./windows/main";

console.log("[main] Local database ready:", !!localDb);
const IS_DEV = process.env.NODE_ENV === "development";

void applyShellEnvToProcess().catch((error) => {
	console.error("[main] Failed to apply shell environment:", error);
});

// Dev mode: name it "Odin Dev" (and it gets the green icon-dev.png in the dock)
// so a hot-reload window is never mistaken for the installed app — both share
// ~/.odin, so knowing which one you're driving matters.
if (IS_DEV) {
	app.setName("Odin Dev");
}

// `bun dev` runs unpackaged, so there is no Info.plist and app.getVersion()
// falls back to Electron's own version — the About panel claimed Odin was
// version 40.x. Baked in from package.json, the same value packaged builds ship.
declare const __APP_VERSION__: string;
app.setAboutPanelOptions({
	applicationVersion: __APP_VERSION__,
	version: __APP_VERSION__,
});

// Dev mode: register with execPath + app script so macOS launches Electron with our entry point
if (process.defaultApp) {
	if (process.argv.length >= 2) {
		app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
			path.resolve(process.argv[1]),
		]);
	}
} else {
	app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}

async function processDeepLink(url: string): Promise<void> {
	// Slack OAuth callback, bounced here by the redirect page. Handled in the
	// main process (it carries an auth code, and the token exchange needs the
	// client secret) — never forwarded to the renderer as navigation.
	if (isSlackOAuthCallback(url)) {
		console.log("[main] Processing Slack OAuth callback");
		await completeSlackOAuth(url);
		focusMainWindow();
		return;
	}

	if (isNotionOAuthCallback(url)) {
		console.log("[main] Processing Notion OAuth callback");
		await completeNotionOAuth(url);
		focusMainWindow();
		return;
	}

	if (isJiraOAuthCallback(url)) {
		console.log("[main] Processing Jira OAuth callback");
		await completeJiraOAuth(url);
		focusMainWindow();
		return;
	}

	console.log("[main] Processing deep link:", url);

	// Non-auth deep links: extract path and navigate in renderer
	// e.g. odin://tasks/my-slug -> /tasks/my-slug
	const path = `/${url.split("://")[1]}`;
	focusMainWindow();

	const windows = BrowserWindow.getAllWindows();
	if (windows.length > 0) {
		windows[0].webContents.send("deep-link-navigate", path);
	}
}

function findDeepLinkInArgv(argv: string[]): string | undefined {
	return argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
}

export function focusMainWindow(): void {
	const windows = BrowserWindow.getAllWindows();
	if (windows.length > 0) {
		const mainWindow = windows[0];
		if (mainWindow.isMinimized()) {
			mainWindow.restore();
		}
		mainWindow.show();
		mainWindow.focus();
	} else {
		// Triggers window creation via makeAppSetup's activate handler
		app.emit("activate");
	}
}

function registerWithMacOSNotificationCenter() {
	if (!PLATFORM.IS_MAC || !Notification.isSupported()) return;

	const registrationNotification = new Notification({
		title: app.name,
		body: " ",
		silent: true,
	});

	let handled = false;
	const cleanup = () => {
		if (handled) return;
		handled = true;
		registrationNotification.close();
	};

	registrationNotification.on("show", () => {
		cleanup();
		console.log("[notifications] Registered with Notification Center");
	});

	// Fallback timeout in case macOS doesn't fire events
	setTimeout(cleanup, 1000);

	registrationNotification.show();
}

// macOS open-url can fire before the window exists (cold-start via protocol link).
// Queue the URL and process it after initialization.
let pendingDeepLinkUrl: string | null = null;
let appReady = false;

app.on("open-url", async (event, url) => {
	event.preventDefault();
	if (appReady) {
		await processDeepLink(url);
	} else {
		pendingDeepLinkUrl = url;
	}
});

let isQuitting = false;
let skipQuitConfirmation = false;
let forceFullCleanup = false;

export function setSkipQuitConfirmation(): void {
	skipQuitConfirmation = true;
}

export function quitApp(): void {
	setSkipQuitConfirmation();
	app.quit();
}

/** Quit + also stop background services. Tray "Quit Completely". */
export function quitAppCompletely(): void {
	forceFullCleanup = true;
	setSkipQuitConfirmation();
	app.quit();
}

/** Bypasses before-quit. Host-service children self-exit via the parent watchdog. */
export function exitImmediately(): void {
	app.exit(0);
}

function getConfirmOnQuitSetting(): boolean {
	try {
		const row = localDb.select().from(settings).get();
		return row?.confirmOnQuit ?? DEFAULT_CONFIRM_ON_QUIT;
	} catch {
		return DEFAULT_CONFIRM_ON_QUIT;
	}
}

app.on("before-quit", async (event) => {
	if (isQuitting) return;

	const isDev = process.env.NODE_ENV === "development";
	if (!skipQuitConfirmation && !isDev && getConfirmOnQuitSetting()) {
		event.preventDefault();

		try {
			const { response } = await dialog.showMessageBox({
				type: "question",
				buttons: ["Quit", "Cancel"],
				defaultId: 0,
				cancelId: 1,
				title: "Quit Odin",
				message: "Are you sure you want to quit?",
			});

			if (response === 1) {
				return;
			}
		} catch (error) {
			console.error("[main] Quit confirmation dialog failed:", error);
		}
	}

	isQuitting = true;
	// Persist tab/session state before teardown so the board survives quit.
	flushAppStateSync();
	flushWindowStateSync();
	await runQuitCleanup({
		isDev,
		forceFullCleanup,
		isUpdateInstalling: isUpdateReadyToInstall(),
		stopHostServices: () => getHostServiceCoordinator().stopAll(),
		teardownTerminalHost,
		disposeTerminalHostClient,
		shutdownPersistence: shutdownTanstackDbPersistence,
		disposeTray,
		stopNetworkLogger,
		forceExit: (code) => app.exit(code),
	});
});

/**
 * Fully stop the v1 terminal-host process. Do not call this for update
 * installs: terminal-host owns the PTY subprocesses, so shutdown is
 * destructive and prevents reattach on next launch.
 */
async function teardownTerminalHost(): Promise<void> {
	try {
		await getTerminalHostClient().shutdownIfRunning({ killSessions: true });
	} catch (err) {
		console.warn("[main] terminal-host dev shutdown failed:", err);
	}
	disposeTerminalHostClient();
}

process.on("uncaughtException", (error) => {
	if (isQuitting) return;
	console.error("[main] Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
	if (isQuitting) return;
	console.error("[main] Unhandled rejection:", reason);
});

// Without these handlers, Electron may not quit when electron-vite sends SIGTERM
if (process.env.NODE_ENV === "development") {
	let signalHandled = false;
	const handleTerminationSignal = (signal: string) => {
		if (signalHandled) return;
		signalHandled = true;
		console.log(`[main] Received ${signal}, quitting...`);
		// Persist tab/session state synchronously first — the async lowdb write
		// wouldn't finish before app.exit(0), which is what drops the board on a
		// dev (--watch SIGTERM) restart.
		flushAppStateSync();
		flushWindowStateSync();
		getHostServiceCoordinator().stopAll();
		void Promise.allSettled([
			teardownTerminalHost(),
			stopNetworkLogger(),
		]).finally(() => app.exit(0));
	};

	process.on("SIGTERM", () => handleTerminationSignal("SIGTERM"));
	process.on("SIGINT", () => handleTerminationSignal("SIGINT"));

	// Fallback: electron-vite may exit without signaling the child Electron process
	const parentPid = process.ppid;
	const isParentAlive = (): boolean => {
		try {
			process.kill(parentPid, 0);
			return true;
		} catch {
			return false;
		}
	};

	const parentCheckInterval = setInterval(() => {
		if (!isParentAlive()) {
			console.log("[main] Parent process exited, quitting...");
			clearInterval(parentCheckInterval);
			handleTerminationSignal("parent-exit");
		}
	}, 1000);
	parentCheckInterval.unref();
}

protocol.registerSchemesAsPrivileged([
	{
		scheme: "odin-icon",
		privileges: {
			standard: true,
			secure: true,
			bypassCSP: true,
			supportFetchAPI: true,
		},
	},
	{
		scheme: "odin-font",
		privileges: {
			standard: true,
			secure: true,
			bypassCSP: true,
			supportFetchAPI: true,
		},
	},
]);

const gotTheLock = app.requestSingleInstanceLock();

// Electron's lock is per bundle id, so it only catches a second copy of *this*
// build. The dev build and the packaged app have different bundle ids and share
// one home dir, so both would otherwise run and fight over app-state.json —
// which is what silently drags you off the session you're working in.
const uiLock = gotTheLock
	? acquireSingleUiLock(app.getName())
	: ({ ok: false, holder: null } as const);

if (!gotTheLock) {
	app.exit(0);
} else if (!uiLock.ok) {
	dialog.showErrorBox(
		"Another Odin is already running",
		uiLock.holder
			? `"${uiLock.holder.app}" (pid ${uiLock.holder.pid}) is using ${ODIN_HOME_DIR}. ` +
					"Quit it before starting this one — two UIs on one home directory " +
					"overwrite each other's open tabs and panes."
			: `Another UI is using ${ODIN_HOME_DIR}. Quit it before starting this one.`,
	);
	app.exit(0);
} else {
	app.on("will-quit", uiLock.release);

	// Windows/Linux: protocol URL arrives as argv on the second instance
	app.on("second-instance", async (_event, argv) => {
		focusMainWindow();
		const url = findDeepLinkInArgv(argv);
		if (url) {
			await processDeepLink(url);
		}
	});

	(async () => {
		await app.whenReady();
		registerWithMacOSNotificationCenter();
		// The one permission worth asking for up front: an Automation prompt
		// mid-session blocks the osascript an agent just ran. Everything else
		// prompts naturally the first time something actually touches it.
		requestAppleEventsAccess();

		// Must register on both default session and the app's custom partition
		const iconProtocolHandler = (request: Request) => {
			const url = new URL(request.url);
			const projectId = url.pathname.replace(/^\//, "");
			const iconPath = getProjectIconPath(projectId);
			if (!iconPath) {
				return new Response("Not found", { status: 404 });
			}
			return net.fetch(pathToFileURL(iconPath).toString());
		};
		protocol.handle("odin-icon", iconProtocolHandler);
		session
			.fromPartition("persist:odin")
			.protocol.handle("odin-icon", iconProtocolHandler);

		// Serve system fonts (e.g. SF Mono on macOS) via custom protocol
		// so the renderer can use @font-face with font-src 'self' CSP
		if (process.platform === "darwin") {
			const SYSTEM_FONT_DIRS = [
				"/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts",
				"/System/Library/Fonts",
				"/Library/Fonts",
			];
			const fontProtocolHandler = async (request: Request) => {
				const url = new URL(request.url);
				const filename = path.basename(url.pathname);
				if (!/\.(otf|ttf|woff2?)$/i.test(filename)) {
					return new Response("Not found", { status: 404 });
				}
				for (const dir of SYSTEM_FONT_DIRS) {
					const fontPath = path.join(dir, filename);
					try {
						return await net.fetch(pathToFileURL(fontPath).toString());
					} catch {
						// Not in this directory
					}
				}
				return new Response("Not found", { status: 404 });
			};
			protocol.handle("odin-font", fontProtocolHandler);
			session
				.fromPartition("persist:odin")
				.protocol.handle("odin-font", fontProtocolHandler);
		}

		ensureProjectIconsDir();
		setWorkspaceDockIcon();
		initSentry();
		await initAppState();
		initTanstackDbPersistence();

		try {
			await startNetworkLogger();
		} catch (error) {
			console.error("[main] Failed to start network logger:", error);
		}

		await loadWebviewBrowserExtension();

		// Must happen before renderer restore runs
		await reconcileDaemonSessions();
		prewarmTerminalRuntime();

		const hostServiceCoordinator = getHostServiceCoordinator();

		// One organization, and it is this machine.
		void hostServiceCoordinator
			.reconcile([LOCAL_ORG_ID])
			.catch((error: unknown) => {
				console.error("[main] host-service reconcile failed:", error);
			});

		try {
			setupAgentIntegrations();
		} catch (error) {
			console.error("[main] Failed to set up agent integrations:", error);
		}

		if (IS_DEV) {
			hostServiceCoordinator.enableDevReload();
		}

		await makeAppSetup(() => MainWindow());
		setupAutoUpdater();
		initTray();

		const coldStartUrl = findDeepLinkInArgv(process.argv);
		if (coldStartUrl) {
			await processDeepLink(coldStartUrl);
		}
		if (pendingDeepLinkUrl) {
			await processDeepLink(pendingDeepLinkUrl);
			pendingDeepLinkUrl = null;
		}

		appReady = true;
	})();
}
