import { app, BrowserWindow, session, shell } from "electron";
import { env } from "main/env.main";
import { loadReactDevToolsExtension } from "main/lib/extensions";
import { IN_APP_BROWSER_PARTITION, PLATFORM } from "shared/constants";
import { opensInOdin } from "shared/in-odin-links";
import { makeAppId } from "shared/utils";
import { ignoreConsoleWarnings } from "../../utils/ignore-console-warnings";

ignoreConsoleWarnings(["Manifest version 2 is deprecated"]);

export async function makeAppSetup(
	createWindow: () => Promise<BrowserWindow>,
	restoreWindows?: () => Promise<void>,
) {
	await loadReactDevToolsExtension();

	// Restore windows from previous session if available
	if (restoreWindows) {
		await restoreWindows();
	}

	// If no windows were restored, create a new one
	const existingWindows = BrowserWindow.getAllWindows();
	let window: BrowserWindow;
	if (existingWindows.length > 0) {
		window = existingWindows[0];
	} else {
		window = await createWindow();
	}

	app.on("activate", async () => {
		const windows = BrowserWindow.getAllWindows();

		if (!windows.length) {
			window = await createWindow();
		} else {
			// Show hidden windows (macOS hide-to-tray) or restore minimized ones
			for (window of windows.reverse()) {
				window.show();
				window.focus();
			}
		}
	});

	app.on("web-contents-created", (_, contents) => {
		// The in-app browser, and any sign-in popup a page in it opens, browses
		// freely; only Odin's own windows send web links out.
		if (
			contents.getType() === "webview" ||
			contents.session === session.fromPartition(IN_APP_BROWSER_PARTITION)
		) {
			contents.setWindowOpenHandler(({ url, disposition }) => {
				// A sized window.open is a sign-in popup (Notion's "Continue with
				// Google"): it needs a real window that can report back to its
				// opener, and the same no-passkeys switch as the panel.
				if (disposition === "new-window") {
					return {
						action: "allow",
						overrideBrowserWindowOptions: {
							autoHideMenuBar: true,
							webPreferences: { disableBlinkFeatures: "WebAuth" },
						},
					};
				}
				// The panel has no tabs: a link opening one (Slack's, Jira's)
				// loads in place instead, and Back returns - if it's another task
				// source's page. Any other site opens in your browser.
				if (opensInOdin(url)) contents.loadURL(url);
				else if (url.startsWith("http://") || url.startsWith("https://")) {
					shell.openExternal(url);
				}
				return { action: "deny" };
			});
			return;
		}
		contents.on("will-navigate", (event, url) => {
			// Always prevent in-app navigation for external URLs
			if (url.startsWith("http://") || url.startsWith("https://")) {
				event.preventDefault();
				shell.openExternal(url);
			}
		});
	});

	// macOS: keep the app alive (standard behavior) - tray/dock provide re-entry.
	// Windows/Linux: quit the app UI. Host-services are coupled to the app and
	// stop with it; v1 pty-daemon survives separately.
	app.on("window-all-closed", () => !PLATFORM.IS_MAC && app.quit());

	return window;
}

PLATFORM.IS_LINUX && app.disableHardwareAcceleration();

// macOS Sequoia+: occluded window throttling can corrupt GPU compositor layers
if (PLATFORM.IS_MAC) {
	app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
}

PLATFORM.IS_WINDOWS &&
	app.setAppUserModelId(
		env.NODE_ENV === "development" ? process.execPath : makeAppId(),
	);

app.commandLine.appendSwitch("force-color-profile", "srgb");

if (env.NODE_ENV === "development" && process.env.RENDERER_REMOTE_DEBUG_PORT) {
	app.commandLine.appendSwitch(
		"remote-debugging-port",
		process.env.RENDERER_REMOTE_DEBUG_PORT,
	);
}

// this app is Odin - name + valknut dock icon.
app.setName("Odin");
if (PLATFORM.IS_MAC) {
	void app.whenReady().then(() => {
		try {
			const { join } = require("node:path") as typeof import("node:path");
			const iconPath =
				env.NODE_ENV === "development"
					? join(app.getAppPath(), "src/resources/odin/icon.png")
					: join(
							process.resourcesPath,
							"app.asar.unpacked/resources/odin/icon.png",
						);
			app.dock?.setIcon(iconPath);
		} catch {
			// cosmetic only - fall back to the default icon
		}
	});
}

// Each xterm pane holds one WebGL context. v2 parking keeps panes alive
// across workspace switches, so cumulative contexts can reach the low
// hundreds - past Chromium's default cap of 16, Blink force-evicts the
// oldest context and the terminal blanks out. 256 covers the parking load
// while staying bounded enough that a runaway leak still surfaces (Tabby
// raises this to 9000, which masks leaks).
app.commandLine.appendSwitch("max-active-webgl-contexts", "256");
