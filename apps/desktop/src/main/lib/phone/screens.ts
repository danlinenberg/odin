import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { app } from "electron";

/**
 * The phone's screens as this Odin has them, for a paired phone to run in
 * place of the ones built into its app (renderer/mobile/boot.ts): one app.js
 * and one app.css from `bun run build:screens` in apps/mobile. A packaged
 * Odin ships them as a resource; the dev app reads the checkout's build,
 * which scripts/odin-dev.sh makes at every start.
 */
const dir = () =>
	app.isPackaged
		? join(process.resourcesPath, "resources/phone-screens")
		: resolve(app.getAppPath(), "../mobile/dist-screens");

export type Screens = { version: string; js: string; css: string };

let cache: { key: string; screens: Screens } | null = null;

/** The screens and their version (a hash of both files); null when none are built. */
export async function readScreens(from = dir()): Promise<Screens | null> {
	const js = join(from, "app.js");
	const css = join(from, "app.css");
	try {
		const [a, b] = await Promise.all([stat(js), stat(css)]);
		const key = `${from}:${a.mtimeMs}:${a.size}:${b.mtimeMs}:${b.size}`;
		if (cache?.key === key) return cache.screens;
		const [script, style] = await Promise.all([
			readFile(js, "utf-8"),
			readFile(css, "utf-8"),
		]);
		const version = createHash("sha256")
			.update(script)
			.update("\0")
			.update(style)
			.digest("hex")
			.slice(0, 16);
		cache = { key, screens: { version, js: script, css: style } };
		return cache.screens;
	} catch {
		return null;
	}
}
