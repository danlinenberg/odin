import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	app,
	Menu,
	type MenuItemConstructorOptions,
	nativeImage,
	Tray,
} from "electron";
import { focusMainWindow, quitApp } from "main/index";
import { appState } from "main/lib/app-state";
import {
	getHostServiceCoordinator,
	type HostServiceStatusEvent,
} from "main/lib/host-service-coordinator";
import { menuEmitter } from "main/lib/menu-events";
import { notificationsEmitter } from "main/lib/notifications/server";
import { confirmAndQuitCompletely } from "main/lib/quit-completely";
import { getWorkspaceRuntimeRegistry } from "main/lib/workspace-runtime";
import { type ActiveSession, activeSessions } from "shared/active-sessions";
import { LOCAL_ORG_ID, NOTIFICATION_EVENTS } from "shared/constants";
import type { PaneStatus } from "shared/tabs-types";

/** Must have "Template" suffix for macOS dark/light mode support */
const TRAY_ICON_FILENAME = "iconTemplate.png";

function getTrayIconPath(): string | null {
	if (app.isPackaged) {
		const prodPath = join(
			process.resourcesPath,
			"app.asar.unpacked/resources/tray",
			TRAY_ICON_FILENAME,
		);
		if (existsSync(prodPath)) return prodPath;
		return null;
	}

	const previewPath = join(__dirname, "../resources/tray", TRAY_ICON_FILENAME);
	if (existsSync(previewPath)) {
		return previewPath;
	}

	const devPath = join(
		app.getAppPath(),
		"src/resources/tray",
		TRAY_ICON_FILENAME,
	);
	if (existsSync(devPath)) {
		return devPath;
	}

	console.warn("[Tray] Icon not found at:", previewPath, "or", devPath);
	return null;
}

let tray: Tray | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let menuOpen = false;

function createTrayIcon(): Electron.NativeImage | null {
	const iconPath = getTrayIconPath();
	if (!iconPath) {
		console.warn("[Tray] Icon not found");
		return null;
	}

	try {
		let image = nativeImage.createFromPath(iconPath);
		const size = image.getSize();

		if (image.isEmpty() || size.width === 0 || size.height === 0) {
			console.warn("[Tray] Icon loaded with zero size from:", iconPath);
			return null;
		}

		// 16x16 is standard menu bar size, auto-scales for Retina
		if (size.width > 22 || size.height > 22) {
			image = image.resize({ width: 16, height: 16 });
		}
		image.setTemplateImage(true);
		return image;
	} catch (error) {
		console.warn("[Tray] Failed to load icon:", error);
		return null;
	}
}

function openSettings(): void {
	focusMainWindow();
	menuEmitter.emit("open-settings");
}

function buildHostServiceSubmenu(): MenuItemConstructorOptions[] {
	const coordinator = getHostServiceCoordinator();
	const status = coordinator.getProcessStatus(LOCAL_ORG_ID);

	return [
		{ label: status, enabled: false },
		{
			// Enabled in "stopped" too — that's the state where users most need
			// restart to work (host-service crashed or never came up). Disabled
			// only while a start is in flight, to avoid racing the pending start.
			label: "Restart",
			enabled: status !== "starting",
			click: () => {
				void (async () => {
					try {
						await coordinator.restart(LOCAL_ORG_ID);
					} catch (error) {
						console.error("[Tray] Failed to restart host-service:", error);
					}
					void updateTrayMenu();
				})();
			},
		},
		{
			label: "Stop",
			enabled: status === "running",
			click: () => {
				coordinator.stop(LOCAL_ORG_ID);
				void updateTrayMenu();
			},
		},
	];
}

/** The board's columns, in the order you'd want to look at them. */
const SECTIONS: { column: PaneStatus; label: string }[] = [
	{ column: "permission", label: "Needs you" },
	{ column: "working", label: "Working" },
	{ column: "review", label: "Done" },
	{ column: "idle", label: "Idle" },
];

/** Same rule as the All page: the daemon says who's alive, the pane says where it sits. */
async function loadSessions(): Promise<ActiveSession[]> {
	try {
		const { sessions } = await getWorkspaceRuntimeRegistry()
			.getDefault()
			.terminal.management.listSessions();
		const alive = new Set(
			sessions.filter((s) => s.isAlive).map((s) => s.sessionId),
		);
		return activeSessions(appState.data.tabsState.panes ?? {}, alive, null);
	} catch (error) {
		console.warn("[Tray] Failed to list sessions:", error);
		return [];
	}
}

/** Opens the session's drawer on the board — what clicking its banner does. */
function openSession(paneId: string): void {
	focusMainWindow();
	notificationsEmitter.emit(NOTIFICATION_EVENTS.FOCUS_TAB, { paneId });
}

function buildSessionItems(
	sessions: ActiveSession[],
): MenuItemConstructorOptions[] {
	if (sessions.length === 0) {
		return [{ label: "No sessions running", enabled: false }];
	}
	return SECTIONS.flatMap(({ column, label }) => {
		const rows = sessions.filter((s) => s.column === column);
		if (rows.length === 0) return [];
		return [
			{ label: `${label} (${rows.length})`, enabled: false },
			...rows.map(
				(s): MenuItemConstructorOptions => ({
					label: s.repo ? `${s.title} — ${s.repo}` : s.title,
					click: () => openSession(s.paneId),
				}),
			),
		];
	});
}

async function updateTrayMenu(): Promise<void> {
	if (!tray) return;

	const hostServiceSubmenu = buildHostServiceSubmenu();
	const sessions = await loadSessions();
	if (!tray) return;
	// The count beside the icon is the one thing worth seeing without a click.
	const needsYou = sessions.filter((s) => s.column === "permission").length;
	tray.setTitle(needsYou > 0 ? String(needsYou) : "");

	const menu = Menu.buildFromTemplate([
		...buildSessionItems(sessions),
		{ type: "separator" },
		{
			label: "Host Service",
			submenu: hostServiceSubmenu,
		},
		{ type: "separator" },
		{
			label: "Open Odin",
			click: focusMainWindow,
		},
		{
			label: "Settings",
			click: openSettings,
		},
		{
			label: "Check for Updates",
			click: () => {
				// Imported lazily to avoid circular dependency
				const { checkForUpdatesInteractive } = require("../auto-updater");
				checkForUpdatesInteractive();
			},
		},
		{ type: "separator" },
		{
			label: "Close Odin",
			click: () => quitApp(),
		},
		{ type: "separator" },
		{
			label: "Quit Odin Completely",
			click: () => {
				void confirmAndQuitCompletely();
			},
		},
	]);

	// Swapping the menu while it's open would snap it shut under your cursor.
	if (menuOpen) return;
	menu.on("menu-will-show", () => {
		menuOpen = true;
	});
	menu.on("menu-will-close", () => {
		menuOpen = false;
	});
	tray.setContextMenu(menu);
}

/** Call once after app.whenReady() */
export function initTray(): void {
	if (tray) {
		console.warn("[Tray] Already initialized");
		return;
	}

	if (process.platform !== "darwin") {
		return;
	}

	try {
		const icon = createTrayIcon();
		if (!icon) {
			console.warn("[Tray] Skipping initialization - no icon available");
			return;
		}

		tray = new Tray(icon);
		tray.setToolTip("Odin");

		void updateTrayMenu();

		const manager = getHostServiceCoordinator();
		manager.on("status-changed", (_event: HostServiceStatusEvent) => {
			void updateTrayMenu();
		});

		tray.on("mouse-enter", () => {
			void updateTrayMenu();
		});

		// ponytail: same 5s poll the board runs; push from the status writers if it lags.
		refreshTimer = setInterval(() => void updateTrayMenu(), 5_000);

		console.log("[Tray] Initialized successfully");
	} catch (error) {
		console.error("[Tray] Failed to initialize:", error);
	}
}

/** Call on app quit */
export function disposeTray(): void {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = null;
	}
	if (tray) {
		tray.destroy();
		tray = null;
	}
}
