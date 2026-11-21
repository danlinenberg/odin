import { expect, test } from "bun:test";
import { chromeExtensionFiles } from "./chrome-extension";

test("the extension asks this Odin's port and only localhost", () => {
	const files = chromeExtensionFiles(51999);
	const manifest = JSON.parse(files["manifest.json"] as string);
	expect(manifest.manifest_version).toBe(3);
	expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
	expect(files["background.js"]).toContain("const DEFAULT_PORT = 51999;");
	expect(files["popup.js"]).toContain("/sessions/for-url?url=");
	// Both scripts are valid JavaScript.
	for (const name of ["background.js", "popup.js"])
		expect(() => new Function(files[name] as string)).not.toThrow();
});
