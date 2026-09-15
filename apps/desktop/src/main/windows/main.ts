import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { app, Notification, nativeTheme } from "electron";
import log from "electron-log/main";
import { createWindow } from "lib/electron-app/factories/windows/create";
import { createAppRouter } from "lib/trpc/routers";
import { NOTIFICATION_EVENTS, PLATFORM } from "shared/constants";
import {
	env,
	getWorkspaceName as getEnvWorkspaceName,
} from "shared/env.shared";
import type { AgentLifecycleEvent } from "shared/notification-types";
import { createIPCHandler } from "trpc-electron/main";
import { productName } from "~/package.json";
import { appState } from "../lib/app-state";
import { browserManager } from "../lib/browser/browser-manager";
import { attachEditContextMenu } from "../lib/edit-context-menu";
import { createApplicationMenu } from "../lib/menu";
import { playNotificationSound } from "../lib/notification-sound";
import { listenForHooks } from "../lib/notifications/listen";
import { NotificationManager } from "../lib/notifications/notification-manager";
import {
	notificationsApp,
	notificationsEmitter,
} from "../lib/notifications/server";
import {
	extractWorkspaceIdFromUrl,
	getNotificationTitle,
} from "../lib/notifications/utils";
import {
	getInitialWindowBounds,
	loadWindowState,
	saveWindowState,
} from "../lib/window-state";
import { getWorkspaceRuntimeRegistry } from "../lib/workspace-runtime";

// Singleton IPC handler to prevent duplicate handlers on window reopen (macOS)
let ipcHandler: ReturnType<typeof createIPCHandler> | null = null;

let currentWindow: BrowserWindow | null = null;

let flushWindowState: (() => void) | null = null;

/**
 * Persist window bounds + zoom right now. The quit paths end in `app.exit()`,
 * which skips the window's `close` handler, so zoom set from the View menu
 * (Cmd +/-, which emits no event) would otherwise never reach disk.
 */
export function flushWindowStateSync(): void {
	flushWindowState?.();
}

// Routers receive this getter so they always see the current window, not a stale reference
const getWindow = () => currentWindow;

// invalidate() alone may not rebuild corrupted GPU layers — a tiny resize
// forces Chromium to reconstruct the compositor layer tree.
const forceRepaint = (win: BrowserWindow) => {
	if (win.isDestroyed()) return;
	win.webContents.invalidate();
	if (win.isMaximized() || win.isFullScreen()) return;
	const [width, height] = win.getSize();
	win.setSize(width + 1, height);
	setTimeout(() => {
		if (!win.isDestroyed()) win.setSize(width, height);
	}, 32);
};

// GPU process restarts don't repaint existing compositor layers automatically.
app.on("child-process-gone", (_event, details) => {
	if (details.type === "GPU") {
		console.warn("[main-window] GPU process gone:", details.reason);
		const win = getWindow();
		if (win) forceRepaint(win);
	}
});

export async function MainWindow() {
	const savedWindowState = loadWindowState();
	const initialBounds = getInitialWindowBounds(savedWindowState);
	// Restoring zoom via setZoomLevel() after load doesn't stick — Chromium resets
	// it while the renderer boots. webPreferences applies it before the first
	// paint and survives reloads. Clamped: Electron rejects factors outside 25%-500%.
	const initialZoomFactor = Math.min(
		Math.max(1.2 ** (savedWindowState?.zoomLevel ?? 0), 0.25),
		5,
	);

	const isDev = env.NODE_ENV === "development";
	const workspaceName = isDev ? getEnvWorkspaceName() : undefined;
	const windowTitle = workspaceName
		? `${productName} — ${workspaceName}`
		: productName;

	const window = createWindow({
		id: "main",
		title: windowTitle,
		width: initialBounds.width,
		height: initialBounds.height,
		x: initialBounds.x,
		y: initialBounds.y,
		minWidth: 400,
		minHeight: 400,
		show: false,
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#252525" : "#ffffff",
		center: initialBounds.center,
		movable: true,
		resizable: true,
		alwaysOnTop: false,
		autoHideMenuBar: true,
		frame: false,
		titleBarStyle: "hidden",
		// y centres the 12px lights in the 36px top bar (see _odin/layout.tsx),
		// so they line up with the app name beside them.
		trafficLightPosition: { x: 16, y: 12 },
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			webviewTag: true,
			zoomFactor: initialZoomFactor,
			// Isolate Electron session from system browser cookies
			// This ensures desktop uses bearer token auth, not web cookies
			partition: "persist:odin",
		},
	});

	createApplicationMenu();

	attachEditContextMenu(window.webContents);

	currentWindow = window;

	// macOS Sequoia+: background throttling can corrupt GPU compositor layers
	if (PLATFORM.IS_MAC) {
		window.webContents.setBackgroundThrottling(false);
	}

	if (isDev) {
		window.webContents.on(
			"console-message",
			(_event, level, message, line, sourceId) => {
				const shouldForward =
					level >= 2 ||
					message.includes("[stress]") ||
					message.includes("[main]");
				if (!shouldForward) return;

				const details = sourceId ? ` (${sourceId}:${line})` : "";
				const formatted = `[renderer-console] ${message}${details}`;
				if (level >= 3) {
					log.error(formatted);
				} else if (level >= 2) {
					log.warn(formatted);
				} else {
					log.info(formatted);
				}
			},
		);

		window.on("unresponsive", () => {
			log.warn("[main-window] Renderer became unresponsive", {
				url: window.webContents.getURL(),
			});
		});
		window.on("responsive", () => {
			log.info("[main-window] Renderer became responsive", {
				url: window.webContents.getURL(),
			});
		});
	}

	if (ipcHandler) {
		ipcHandler.attachWindow(window);
	} else {
		ipcHandler = createIPCHandler({
			router: createAppRouter(getWindow),
			windows: [window],
		});
	}

	const server = listenForHooks(notificationsApp);

	const notificationManager = new NotificationManager({
		isSupported: () => Notification.isSupported(),
		createNotification: (opts) => new Notification(opts),
		playSound: playNotificationSound,
		onNotificationClick: (ids) => {
			window.show();
			window.focus();
			if (ids.workspaceId && ids.terminalId) {
				notificationsEmitter.emit(
					NOTIFICATION_EVENTS.FOCUS_V2_NOTIFICATION_SOURCE,
					{
						workspaceId: ids.workspaceId,
						source: { type: "terminal", id: ids.terminalId },
					},
				);
				return;
			}
			notificationsEmitter.emit(NOTIFICATION_EVENTS.FOCUS_TAB, ids);
		},
		getVisibilityContext: () => ({
			isFocused: window.isFocused(),
			currentWorkspaceId: extractWorkspaceIdFromUrl(
				window.webContents.getURL(),
			),
			tabsState: appState.data?.tabsState,
		}),
		getNotificationTitle: (event) =>
			getNotificationTitle({
				tabId: event.tabId,
				paneId: event.paneId,
				tabs: appState.data?.tabsState?.tabs,
				panes: appState.data?.tabsState?.panes,
			}),
		isParked: (event) =>
			(event.paneId
				? appState.data?.tabsState?.panes?.[event.paneId]?.odinParked
				: false) ?? false,
	});
	notificationManager.start();

	notificationsEmitter.on(
		NOTIFICATION_EVENTS.AGENT_LIFECYCLE,
		(event: AgentLifecycleEvent) => {
			notificationManager.handleAgentLifecycle(event);
		},
	);

	// Forward low-volume terminal lifecycle events to the renderer via the existing
	// notifications subscription. This is used only for correctness (e.g. clearing
	// stuck agent lifecycle statuses when terminal panes aren't mounted).
	getWorkspaceRuntimeRegistry()
		.getDefault()
		.terminal.on(
			"terminalExit",
			(event: {
				paneId: string;
				exitCode: number;
				signal?: number;
				reason?: "killed" | "exited" | "error";
			}) => {
				notificationsEmitter.emit(NOTIFICATION_EVENTS.TERMINAL_EXIT, {
					paneId: event.paneId,
					exitCode: event.exitCode,
					signal: event.signal,
					reason: event.reason,
				});
			},
		);

	// macOS Sequoia+: occluded/minimized windows can lose compositor layers
	if (PLATFORM.IS_MAC) {
		window.on("restore", () => {
			window.webContents.invalidate();
		});
		window.on("show", () => {
			window.webContents.invalidate();
		});
	}

	// Persist window bounds on move/resize so state survives app.exit(0)
	// (which skips the close handler — e.g. electron-vite SIGTERM during dev).
	// Gated by `initialized` so the initial maximize() doesn't immediately
	// write isMaximized: true back to disk before the user touches the window.
	let initialized = false;
	let hasCompletedFirstLoad = false;
	let saveTimeout: ReturnType<typeof setTimeout> | null = null;
	const saveNow = () => {
		if (!initialized || window.isDestroyed()) return;
		const isMaximized = window.isMaximized();
		const bounds = isMaximized ? window.getNormalBounds() : window.getBounds();
		saveWindowState({
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
			isMaximized,
			zoomLevel: window.webContents.getZoomLevel(),
		});
	};
	flushWindowState = saveNow;
	const debouncedSave = () => {
		if (saveTimeout) clearTimeout(saveTimeout);
		saveTimeout = setTimeout(saveNow, 500);
	};
	window.on("move", debouncedSave);
	window.on("resize", debouncedSave);
	// Only fires for wheel/pinch zoom; menu zoom (Cmd +/-) is caught by the
	// quit-time flush below.
	window.webContents.on("zoom-changed", debouncedSave);

	window.webContents.on("did-finish-load", () => {
		console.log("[main-window] Renderer loaded successfully");

		if (!hasCompletedFirstLoad) {
			if (initialBounds.isMaximized) {
				window.maximize();
			}
			window.show();
			initialized = true;
			hasCompletedFirstLoad = true;
		}
	});

	window.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedURL) => {
			console.error("[main-window] Failed to load renderer:");
			console.error(`  Error code: ${errorCode}`);
			console.error(`  Description: ${errorDescription}`);
			console.error(`  URL: ${validatedURL}`);
			// Show the window anyway so user can see something is wrong
			window.show();
		},
	);

	window.webContents.on("render-process-gone", (_event, details) => {
		console.error("[main-window] Renderer process gone:", details);
		log.error("[main-window] Renderer process gone", details);
	});

	window.webContents.on("preload-error", (_event, preloadPath, error) => {
		console.error("[main-window] Preload script error:");
		console.error(`  Path: ${preloadPath}`);
		console.error(`  Error:`, error);
	});

	window.on("close", () => {
		// Save window state first, before any cleanup
		saveNow();
		flushWindowState = null;

		browserManager.unregisterAll();
		server.close();
		notificationManager.dispose();
		notificationsEmitter.removeAllListeners();
		getWorkspaceRuntimeRegistry().getDefault().terminal.detachAllListeners();
		ipcHandler?.detachWindow(window);
		currentWindow = null;
	});

	return window;
}
