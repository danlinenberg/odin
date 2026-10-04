import { COMPANY } from "@odin/shared/constants";
import { app, BrowserWindow, Menu, shell } from "electron";
import { env } from "main/env.main";
import { resetTerminalStateDev } from "main/lib/terminal/dev-reset";
import { checkForUpdatesInteractive } from "./auto-updater";
import { menuEmitter } from "./menu-events";
import { confirmAndQuitCompletely } from "./quit-completely";

function zoomFocusedWindow(next: (level: number) => number) {
	const contents = BrowserWindow.getFocusedWindow()?.webContents;
	if (contents) contents.zoomLevel = next(contents.zoomLevel);
}

export function createApplicationMenu() {
	const reloadAccelerator = "CmdOrCtrl+R";
	const closeAccelerator = "CmdOrCtrl+Shift+Q";
	const showHotkeysAccelerator = "CmdOrCtrl+/";
	const openSettingsAccelerator = "CmdOrCtrl+,";

	const template: Electron.MenuItemConstructorOptions[] = [
		{
			label: "File",
			submenu: [
				{
					label: "Open Repo...",
					accelerator: "CmdOrCtrl+O",
					click: () => {
						menuEmitter.emit("open-project");
					},
				},
				{ type: "separator" },
				// Explicit click handler (not `role: "close"`) — `role: "close"` adds
				// an implicit CmdOrCtrl+W accelerator that overrides browser-manager's
				// `before-input-event` interception and closes the window instead of
				// the focused pane.
				{
					label: "Close Window",
					click: () => {
						BrowserWindow.getFocusedWindow()?.close();
					},
				},
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				{
					label: "Reload",
					accelerator: reloadAccelerator,
					click: () => {
						BrowserWindow.getFocusedWindow()?.reload();
					},
				},
				// Explicit click handler (not `role: "forceReload"`) — the role adds
				// an implicit CmdOrCtrl+Shift+R accelerator that prevents the renderer's
				// Reopen Closed Tab shortcut from receiving the event.
				{
					label: "Force Reload",
					click: () => {
						BrowserWindow.getFocusedWindow()?.webContents.reloadIgnoringCache();
					},
				},
				{ role: "toggleDevTools" },
				{ type: "separator" },
				// Not the zoom roles: those zoom whatever has focus, so with the in-app
				// browser focused only the browser zoomed. Zooming the window always
				// zooms the browser with it (see InAppBrowser).
				{
					label: "Actual Size",
					accelerator: "CommandOrControl+0",
					click: () => zoomFocusedWindow(() => 0),
				},
				{
					label: "Zoom In",
					accelerator: "CommandOrControl+Plus",
					click: () => zoomFocusedWindow((level) => level + 0.5),
				},
				{
					label: "Zoom Out",
					accelerator: "CommandOrControl+-",
					click: () => zoomFocusedWindow((level) => level - 0.5),
				},
				{ type: "separator" },
				{
					label: "Toggle Presets Bar",
					click: () => {
						menuEmitter.emit("toggle-presets-bar");
					},
				},
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "Window",
			submenu: [
				{ role: "minimize" },
				{ role: "zoom" },
				{ type: "separator" },
				{ role: "close", accelerator: closeAccelerator },
			],
		},
		{
			label: "Help",
			submenu: [
				{
					label: "Report Issue",
					click: () => {
						shell.openExternal(COMPANY.REPORT_ISSUE_URL);
					},
				},
				{ type: "separator" },
				{
					label: "Keyboard Shortcuts",
					accelerator: showHotkeysAccelerator,
					click: () => {
						menuEmitter.emit("open-settings", "keyboard");
					},
				},
			],
		},
	];

	// DEV ONLY: Add Dev menu
	if (env.NODE_ENV === "development") {
		template.push({
			label: "Dev",
			submenu: [
				{
					label: "Reset Terminal State",
					click: () => {
						resetTerminalStateDev()
							.then(() => {
								for (const window of BrowserWindow.getAllWindows()) {
									window.reload();
								}
							})
							.catch((error) => {
								console.error("[menu] Failed to reset terminal state:", error);
							});
					},
				},
			],
		});
	}

	if (process.platform === "darwin") {
		template.unshift({
			label: app.name,
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				{
					label: "Settings...",
					accelerator: openSettingsAccelerator,
					click: () => {
						menuEmitter.emit("open-settings");
					},
				},
				{
					label: "Check for Updates...",
					click: () => {
						checkForUpdatesInteractive();
					},
				},
				{ type: "separator" },
				{ role: "services" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" },
				{
					label: "Quit Odin Completely",
					click: () => {
						void confirmAndQuitCompletely();
					},
				},
			],
		});
	}

	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
}
