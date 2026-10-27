import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { ODIN_HOME_DIR } from "./app-environment";

const LSREGISTER =
	"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const STAMP = join(ODIN_HOME_DIR, "notification-icon.sha256");

/**
 * Whether the notification icon cache needs a refresh: the bundle's icon is not
 * the one the last refresh was for. No stamp yet counts as changed, so an
 * install whose banners already drew a stale icon is refreshed once too.
 */
export function iconCacheIsStale(
	iconHash: string,
	stamp: string | null,
): boolean {
	return stamp?.trim() !== iconHash;
}

/**
 * Bundles an update parked in a stale/ folder (any Odin home) that Launch
 * Services still has registered, out of an `lsregister -dump`. They share the
 * installed bundle's ID, and banners can draw one of their older icons.
 */
export function parkedBundles(dump: string): string[] {
	const paths = new Set<string>();
	for (const match of dump.matchAll(
		/^path:\s+(.*\/stale\/Odin-\d+\.app)(?: \(0x[0-9a-f]+\))?$/gm,
	)) {
		if (match[1]) paths.add(match[1]);
	}
	return [...paths];
}

/**
 * usernoted snapshots an app's icon the first time it sees the bundle ID, and
 * NotificationCenter keeps its own in-memory copy, so banners kept an old Odin
 * icon through icon changes. Every install path (the in-app update, brew,
 * scripts/odin-update.sh, a DMG dragged in) ends in this launch, so it is done
 * here: when the bundle's icon.icns differs from the last one, unregister the
 * parked bundles, re-register this one and bounce both (launchd restarts them), the same as
 * patch-dev-protocol.ts does for the dev bundle.
 */
export function refreshNotificationIconCache(): void {
	if (process.platform !== "darwin" || !app.isPackaged) return;
	if (process.env.ODIN_SMOKE) return;
	let iconHash: string;
	try {
		iconHash = createHash("sha256")
			.update(readFileSync(join(process.resourcesPath, "icon.icns")))
			.digest("hex");
	} catch {
		return;
	}
	let stamp: string | null = null;
	try {
		stamp = readFileSync(STAMP, "utf8");
	} catch {}
	if (!iconCacheIsStale(iconHash, stamp)) return;

	console.log("[notification-icon] App icon changed - refreshing the cache");
	const bundle = join(process.resourcesPath, "..", "..");
	execFile(
		LSREGISTER,
		["-dump"],
		{ maxBuffer: 200 * 1024 * 1024 },
		(_error, dump) => {
			for (const parked of parkedBundles(String(dump ?? ""))) {
				execFile(LSREGISTER, ["-u", parked], () => {});
			}
			execFile(LSREGISTER, ["-f", bundle], () => {
				execFile(
					"/usr/bin/killall",
					["usernoted", "NotificationCenter"],
					() => {
						try {
							writeFileSync(STAMP, `${iconHash}\n`);
						} catch (error) {
							console.error(
								"[notification-icon] Could not write the stamp:",
								error,
							);
						}
					},
				);
			});
		},
	);
}
