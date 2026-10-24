import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";

/**
 * The phone's screens as this Odin has them, for a paired phone to run in
 * place of the ones built into its app (renderer/mobile/boot.ts): one app.js
 * and one app.css from `bun run build:screens` in apps/mobile. A packaged
 * Odin ships them as a resource; the dev app reads the checkout's build,
 * which scripts/odin-dev.sh makes at every start and freshScreens remakes
 * when the checkout moves to another commit.
 */
const dir = () =>
	app.isPackaged
		? join(process.resourcesPath, "resources/phone-screens")
		: resolve(app.getAppPath(), "../mobile/dist-screens");

export type Screens = { version: string; js: string; css: string };

let cache: { key: string; screens: Screens } | null = null;

const run = promisify(execFile);

/** Which commit the dev build was made from, beside it. */
const STAMP = ".built-from";

let building: Promise<void> | null = null;

/**
 * The dev app's screens, rebuilt first when the checkout's commit is not the
 * one they were built from. The build ran only at start, so a checkout that
 * moved on (a pull while Odin ran) kept sending the phone the screens from
 * before it. Any failure leaves the last build in place.
 */
async function freshScreens(): Promise<void> {
	if (app.isPackaged) return;
	const mobile = resolve(app.getAppPath(), "../mobile");
	const head = await run("git", ["-C", mobile, "rev-parse", "HEAD"])
		.then(({ stdout }) => stdout.trim())
		.catch(() => "");
	if (!head) return;
	const built = await readFile(join(dir(), STAMP), "utf-8").catch(() => "");
	if (built.trim() === head) return;
	// odin-dev.sh puts Homebrew's bin first; an app opened from the Dock may not have it.
	building ??= run("/bin/zsh", ["-lc", "bun run build:screens"], {
		cwd: mobile,
	})
		.then(() => writeFile(join(dir(), STAMP), head))
		.catch(() => {})
		.finally(() => {
			building = null;
		});
	await building;
}

/** The screens and their version (a hash of both files); null when none are built. */
export async function readScreens(from?: string): Promise<Screens | null> {
	if (!from) await freshScreens();
	from ??= dir();
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
