/**
 * The Chrome Web Store package: `bun run chrome-extension:zip` writes
 * dist/odin-chrome-extension.zip to upload in the store's developer dashboard.
 * It asks Odin's default port; the popup offers a port field when Odin moved.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	chromeExtensionFiles,
	STORE_ICON,
} from "../src/main/lib/chrome-extension";
import { env } from "../src/shared/env.shared";

const desktop = resolve(import.meta.dir, "..");
const dir = join(desktop, "dist/chrome-extension");
const zip = join(desktop, "dist/odin-chrome-extension.zip");
rmSync(dir, { recursive: true, force: true });
rmSync(zip, { force: true });
mkdirSync(dir, { recursive: true });

const files = chromeExtensionFiles(env.DESKTOP_NOTIFICATIONS_PORT, {
	store: true,
});
for (const [name, text] of Object.entries(files))
	writeFileSync(join(dir, name), text);
copyFileSync(
	join(desktop, "../../packages/ui/src/assets/icons/preset-icons/odin.png"),
	join(dir, STORE_ICON),
);
execFileSync(
	"python3",
	["-m", "zipfile", "-c", zip, ...Object.keys(files), STORE_ICON],
	{ cwd: dir, stdio: "inherit" },
);
console.log(zip);
