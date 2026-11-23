import { expect, test } from "bun:test";
import { chromeExtensionFiles } from "./chrome-extension";

test("the extension asks this Odin's port and only localhost", () => {
	const files = chromeExtensionFiles(51999);
	const manifest = JSON.parse(files["manifest.json"] as string);
	expect(manifest.manifest_version).toBe(3);
	expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
	expect(files["background.js"]).toContain("const DEFAULT_PORT = 51999;");
	expect(files["popup.js"]).toContain("/sessions/for-url?url=");
	// A session still working turns the badge green and says so in the list.
	expect(files["background.js"]).toContain('live ? "#16a34a"');
	expect(files["popup.js"]).toContain("Working now");
	// ...and draws the banner on the page.
	expect(files["background.js"]).toContain("chrome.scripting.executeScript");
	// Both scripts are valid JavaScript.
	for (const name of ["background.js", "popup.js"])
		expect(() => new Function(files[name] as string)).not.toThrow();
});

test("the store build names its icon; the folder build has none to load", () => {
	const store = JSON.parse(
		chromeExtensionFiles(51741, { store: true })["manifest.json"] as string,
	);
	expect(store.icons).toEqual({ "128": "icon128.png" });
	const folder = JSON.parse(
		chromeExtensionFiles(51741)["manifest.json"] as string,
	);
	expect(folder.icons).toBeUndefined();
});
