/**
 * The `electron` module for a remote server, where the desktop's connection
 * code (main/odin-core) runs under plain Node. Those modules import electron
 * for things a server has no use for - a window, the Keychain, opening a
 * browser - so this answers like a headless machine instead of crashing at
 * load: no windows, no secure storage, URLs logged rather than opened (the
 * laptop opens sign-in pages itself). Anything else is an inert stub.
 *
 * Shipped to <odin folder>/node_modules/electron, which both require() and
 * import() reach walking up from the backend bundle. Only the server's odin
 * folder has it; the laptop's real electron is never shadowed.
 */
export const ELECTRON_SHIM_SOURCE = `"use strict";
const os = require("node:os");
const path = require("node:path");
const home = process.env.ODIN_HOME_DIR || path.join(os.homedir(), ".odin");

// Callable, constructible, and every property is itself a stub: code that
// wires up listeners or reads flags at load time gets something harmless.
function stub(name) {
  const fn = function () { return stub(name + "()"); };
  return new Proxy(fn, {
    get(_t, key) {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "then") return undefined;
      return stub(name + "." + String(key));
    },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
}

const noop = () => {};
const emitter = { on: noop, once: noop, off: noop, removeListener: noop, emit: () => false };

const app = Object.assign(Object.create(null), emitter, {
  isPackaged: false,
  name: "Odin",
  getName: () => "Odin",
  getVersion: () => process.env.ODIN_APP_VERSION || "remote",
  getAppPath: () => __dirname,
  getPath: (which) => (which === "home" ? os.homedir() : which === "temp" ? os.tmpdir() : path.join(home, which)),
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  quit: noop,
  exit: (code) => process.exit(code),
  setAsDefaultProtocolClient: () => false,
});

const shell = {
  openExternal: async (url) => { console.log("[odin-core] (laptop opens) " + url); },
  openPath: async () => "",
  showItemInFolder: noop,
};

const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error("Secure storage is not available on the server."); },
  decryptString: () => { throw new Error("Secure storage is not available on the server."); },
};

const powerMonitor = Object.assign({}, emitter, {
  isOnBatteryPower: () => false,
  onBatteryPower: false,
  getSystemIdleTime: () => 0,
});

// Spelled out as exports.X = ... so import("electron") sees named exports too:
// Node's ESM loader only detects CommonJS exports it can read statically.
exports.app = app;
exports.shell = shell;
exports.safeStorage = safeStorage;
exports.powerMonitor = powerMonitor;
exports.powerSaveBlocker = { start: () => 0, stop: noop, isStarted: () => false };
exports.BrowserWindow = Object.assign(stub("BrowserWindow"), { getAllWindows: () => [], getFocusedWindow: () => null });
exports.ipcMain = Object.assign({}, emitter, { handle: noop, removeHandler: noop });
exports.dialog = stub("dialog");
exports.nativeImage = stub("nativeImage");
exports.Notification = Object.assign(stub("Notification"), { isSupported: () => false });
exports.Menu = stub("Menu");
exports.MenuItem = stub("MenuItem");
exports.Tray = stub("Tray");
exports.clipboard = stub("clipboard");
exports.nativeTheme = Object.assign({}, emitter, { shouldUseDarkColors: false, themeSource: "system" });
exports.screen = stub("screen");
exports.session = stub("session");
exports.protocol = stub("protocol");
exports.net = stub("net");
exports.webContents = stub("webContents");
exports.globalShortcut = stub("globalShortcut");
exports.systemPreferences = stub("systemPreferences");
exports.crashReporter = stub("crashReporter");
exports.autoUpdater = stub("autoUpdater");
exports.contentTracing = stub("contentTracing");
exports.utilityProcess = stub("utilityProcess");
exports.MessageChannelMain = stub("MessageChannelMain");
exports.WebContentsView = stub("WebContentsView");
`;

export const ELECTRON_SHIM_PACKAGE_JSON = `${JSON.stringify(
	{ name: "electron", version: "0.0.0-odin-remote", main: "index.js" },
	null,
	2,
)}\n`;
