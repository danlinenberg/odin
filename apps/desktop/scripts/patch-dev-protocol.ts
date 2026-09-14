#!/usr/bin/env bun
/**
 * Patches the development Electron.app's Info.plist to register a
 * workspace-specific URL scheme (odin-{workspace}://) for deep linking.
 *
 * Each worktree gets a unique bundle ID and protocol scheme so macOS Launch
 * Services treats them as distinct apps and routes deep links correctly.
 *
 * Needed because app.setAsDefaultProtocolClient() only works when packaged.
 */

import { Database as BunSqliteDatabase } from "bun:sqlite";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { config } from "dotenv";

// override: true ensures .env values take precedence over inherited env vars
config({
	path: resolve(import.meta.dirname, "../../../.env"),
	override: true,
	quiet: true,
});

// Import directly — shared/constants.ts would trigger Zod env validation during predev
import {
	deriveWorkspaceNameFromWorktreeSegments,
	getWorkspaceName,
} from "../src/shared/worktree-id";

const DEFAULT_WORKTREE_BASE = resolve(homedir(), ".odin/worktrees");
const DEFAULT_PROD_DB_PATH = resolve(homedir(), ".odin/local.db");

type ResolveWorkspaceIdentityOptions = {
	cwd?: string;
	envWorkspaceName?: string;
	lookupDisplayName?: (worktreePath: string) => string | undefined;
	worktreeBase?: string;
};

export function getWorktreeSegmentsFromCwd(
	cwd = process.cwd(),
	worktreeBase = DEFAULT_WORKTREE_BASE,
): string[] | undefined {
	const cwdRelative = relative(worktreeBase, cwd);

	if (!cwdRelative || cwdRelative.startsWith("..") || isAbsolute(cwdRelative)) {
		return undefined;
	}

	const segments = cwdRelative.split(sep).filter(Boolean);
	return segments.length >= 2 ? segments : undefined;
}

export function deriveWorkspaceNameFromSegments(
	segments: string[] | undefined,
): string | undefined {
	if (!segments) return undefined;
	return deriveWorkspaceNameFromWorktreeSegments(segments);
}

export function deriveWorktreePathFromSegments(
	segments: string[] | undefined,
	worktreeBase = DEFAULT_WORKTREE_BASE,
): string | undefined {
	if (!segments) return undefined;

	const appsIndex = segments.lastIndexOf("apps");
	const endIndex =
		appsIndex > 1 && segments[appsIndex + 1] === "desktop"
			? appsIndex
			: segments.length;
	if (endIndex <= 1) return undefined;

	return resolve(worktreeBase, ...segments.slice(0, endIndex));
}

export function getWorkspaceDisplayNameFromProdDb(
	worktreePath: string,
	prodDbPath = DEFAULT_PROD_DB_PATH,
): string | undefined {
	if (!existsSync(prodDbPath)) return undefined;

	try {
		const prodDb = new BunSqliteDatabase(prodDbPath, {
			readonly: true,
			create: false,
		});
		try {
			const row = prodDb
				.query(
					`SELECT w.name as name
					 FROM workspaces w
					 INNER JOIN worktrees wt ON w.worktree_id = wt.id
					 WHERE wt.path = ?
					   AND w.deleting_at IS NULL
					 ORDER BY w.last_opened_at DESC
					 LIMIT 1`,
				)
				.get(worktreePath) as { name?: string } | null;
			const name = row?.name?.trim();
			return name ? name : undefined;
		} finally {
			prodDb.close();
		}
	} catch (error) {
		console.warn(
			"[patch-dev-protocol] Failed to resolve workspace display name from prod DB:",
			error,
		);
		return undefined;
	}
}

export function resolveWorkspaceIdentity(
	options: ResolveWorkspaceIdentityOptions = {},
): {
	bundleDisplayWorkspaceName?: string;
	displayWorkspaceName?: string;
	worktreePath?: string;
	workspaceName?: string;
} {
	const worktreeSegments = getWorktreeSegmentsFromCwd(
		options.cwd,
		options.worktreeBase,
	);
	const workspaceName =
		deriveWorkspaceNameFromSegments(worktreeSegments) ??
		options.envWorkspaceName;
	if (!workspaceName) {
		return {};
	}

	const worktreePath = deriveWorktreePathFromSegments(
		worktreeSegments,
		options.worktreeBase,
	);
	const resolvedDisplayName = worktreePath
		? options.lookupDisplayName?.(worktreePath)?.trim()
		: undefined;
	const displayWorkspaceName = resolvedDisplayName || workspaceName;
	const bundleDisplayWorkspaceName =
		displayWorkspaceName
			.replaceAll("/", "-")
			.replaceAll(/[^a-zA-Z0-9 -]/g, "")
			.trim() || workspaceName;

	return {
		workspaceName,
		worktreePath,
		displayWorkspaceName,
		bundleDisplayWorkspaceName,
	};
}

const DEV_ICON_PNG = resolve(
	import.meta.dirname,
	"../src/resources/build/icons/icon-dev.png",
);

// Kept in sync with IDENTITY in scripts/create-signing-identity.sh.
const LOCAL_SIGNING_IDENTITY = "Odin Local Signing";

/**
 * Rebuilds the bundle's CFBundleIconFile from Odin's dev icon.
 *
 * Notification banners, Launch Services and the app switcher read the icon off
 * disk from the bundle — `app.setName()` and the dock-icon code never reach
 * them, so an agent-complete banner showed Electron's atom logo. Generated from
 * the PNG rather than committed as a second .icns so it can't go stale the way
 * the checked-in `icon-dev.icns` did.
 */
export function writeBundleIcon(appPath: string): void {
	const iconsetDir =
		mkdtempSync(join(tmpdir(), "odin-icon-")) + "/icon.iconset";
	mkdirSync(iconsetDir);
	const variants: [number, string][] = [
		[16, "icon_16x16"],
		[32, "icon_16x16@2x"],
		[32, "icon_32x32"],
		[64, "icon_32x32@2x"],
		[128, "icon_128x128"],
		[256, "icon_128x128@2x"],
		[256, "icon_256x256"],
		[512, "icon_256x256@2x"],
		[512, "icon_512x512"],
		[1024, "icon_512x512@2x"],
	];
	for (const [size, name] of variants) {
		execSync(
			`/usr/bin/sips -z ${size} ${size} "${DEV_ICON_PNG}" --out "${iconsetDir}/${name}.png"`,
			{ stdio: "ignore" },
		);
	}
	execSync(
		`/usr/bin/iconutil -c icns "${iconsetDir}" -o "${appPath}/Contents/Resources/electron.icns"`,
	);
	rmSync(dirname(iconsetDir), { recursive: true, force: true });

	// IconServices caches a bundle's icon by path and only re-reads it when the
	// bundle's own mtime moves — rewriting electron.icns underneath it is
	// invisible. This bundle was Electron.app first and kept its inode through
	// the rename, so notifications kept drawing the cached atom logo while the
	// icns on disk was already Odin's. mtime only: the signature seals file
	// contents, so the seal survives.
	execSync(`/usr/bin/touch "${appPath}" "${appPath}/Contents/Info.plist"`);
}

/**
 * A dev bundle ID unique to this checkout.
 *
 * macOS keys notification prefs and deep-link routing to the bundle ID, and the
 * workspace name is not unique: a copied `.env` handed a Odin worktree the
 * same slug, so its stock-Electron bundle claimed this same ID and macOS listed
 * both as sources for one app. Hashing the bundle path gives one identity per
 * checkout. The path is the symlinked `apps/desktop/node_modules` one, not its
 * .bun realpath, so an Electron upgrade keeps the ID (and its TCC grants).
 *
 * Not what put Electron's atom on the banners — that was the two icon caches
 * handled in `writeBundleIcon` and after the Launch Services re-register.
 */
export function devBundleId(distDir: string): string {
	const hash = createHash("sha256").update(distDir).digest("hex").slice(0, 10);
	return `com.odin.desktop.dev.${hash}`;
}

/**
 * The identity to re-sign the patched dev bundle with.
 *
 * macOS keys privacy grants (screen recording, mic, automation) to the
 * signature, and ad-hoc gives every re-sign a different one — so each re-patch
 * silently revoked Odin's permissions and macOS prompted again. Reuse the stable
 * self-signed cert the packaged build uses (`scripts/create-signing-identity.sh`)
 * when it's in the keychain; fall back to ad-hoc, which still beats no seal.
 */
export function signingIdentity(): string {
	try {
		const identities = execSync(
			"/usr/bin/security find-identity -v -p codesigning",
			{
				encoding: "utf-8",
			},
		);
		if (identities.includes(LOCAL_SIGNING_IDENTITY)) {
			return `"${LOCAL_SIGNING_IDENTITY}"`;
		}
	} catch {}
	return "-";
}

/**
 * True when the bundle carries a signature that seals its Info.plist.
 *
 * Electron ships linker-signed adhoc binaries with no bundle seal, and the
 * PlistBuddy edits below would invalidate one anyway. Without a seal macOS
 * can't resolve the bundle's identity, so notification banners fall back to a
 * generic "Notification" instead of the app's name. Re-signing binds the
 * patched plist and the new icon into the signature; adhoc hashes the contents,
 * so an unchanged bundle re-signs to the same identity and TCC grants survive.
 */
export function hasValidSignature(appPath: string): boolean {
	try {
		execSync(`/usr/bin/codesign --verify "${appPath}"`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const LSREGISTER =
	"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

// Upstream names the dev bundle after the workspace so several concurrent dev
// instances stay apart. Odin only ever runs one, and the workspace slug it
// picked up read as "Odin (so-this-is-a-complex-project-i-w)" in the menu
// bar. Match app.setName("Odin Dev") in main/index.ts instead — CFBundleName
// is what macOS shows, setName alone doesn't reach it.
export const DISPLAY_NAME = "Odin Dev";
export const DEV_APP_BUNDLE_NAME = `${DISPLAY_NAME}.app`;

/**
 * Register the patched bundle so odin-*:// deep links reach the dev app.
 *
 * odin-dev.sh drops this again when the dev stack stops: registered but not
 * running, "Odin Dev" is still openable from Spotlight, and opening it launches
 * the bare Electron binary with no app path — which is Electron's welcome
 * screen ("Electron path-to-app"), not Odin. So this has to run on EVERY dev
 * start, including the fast path where the bundle itself needs no patching.
 */
export function registerWithLaunchServices(appPath: string): void {
	try {
		execSync(`${LSREGISTER} -f "${appPath}"`);
		console.log("[patch-dev-protocol] Registered with Launch Services");
	} catch (err) {
		console.warn(
			"[patch-dev-protocol] Failed to register with Launch Services:",
			err,
		);
	}
}

export function main() {
	if (process.platform !== "darwin") {
		console.log("[patch-dev-protocol] Skipping - not macOS");
		process.exit(0);
	}

	if (process.env.NODE_ENV !== "development") {
		console.log("[patch-dev-protocol] Skipping - non-development mode");
		process.exit(0);
	}

	// Prefer path-derived name so stale .env values never override the active worktree.
	const { workspaceName, worktreePath } = resolveWorkspaceIdentity({
		cwd: process.cwd(),
		envWorkspaceName: getWorkspaceName(),
		lookupDisplayName: getWorkspaceDisplayNameFromProdDb,
	});
	if (!workspaceName) {
		console.log("[patch-dev-protocol] Skipping - workspace name not resolved");
		process.exit(0);
	}

	const PROTOCOL_SCHEME = `odin-${workspaceName}`;
	const ELECTRON_DIST_DIR = resolve(
		import.meta.dirname,
		"../node_modules/electron/dist",
	);
	const BUNDLE_ID = devBundleId(ELECTRON_DIST_DIR);
	const ELECTRON_APP_PATH = resolve(ELECTRON_DIST_DIR, "Electron.app");
	const PLIST_PATH = resolve(ELECTRON_APP_PATH, "Contents/Info.plist");

	if (!existsSync(PLIST_PATH)) {
		console.log("[patch-dev-protocol] Electron.app not found, skipping");
		process.exit(0);
	}

	try {
		const currentBundleId = execSync(
			`/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "${PLIST_PATH}" 2>/dev/null`,
			{ encoding: "utf-8" },
		).trim();
		const currentScheme = execSync(
			`/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0" "${PLIST_PATH}" 2>/dev/null`,
			{ encoding: "utf-8" },
		).trim();
		const currentName = execSync(
			`/usr/libexec/PlistBuddy -c "Print :CFBundleName" "${PLIST_PATH}" 2>/dev/null`,
			{ encoding: "utf-8" },
		).trim();

		// Also check if the .app has been renamed and path.txt is updated
		const isRenamed =
			lstatSync(ELECTRON_APP_PATH).isSymbolicLink() &&
			readlinkSync(ELECTRON_APP_PATH) === `${DISPLAY_NAME}.app`;
		const electronPkgCheck = resolve(
			import.meta.dirname,
			"../node_modules/electron",
		);
		const pathTxtCheck = resolve(electronPkgCheck, "path.txt");
		let pathTxtCorrect = false;
		try {
			pathTxtCorrect =
				readFileSync(pathTxtCheck, "utf-8").trim() ===
				`${DISPLAY_NAME}.app/Contents/MacOS/Electron`;
		} catch {}

		// Regenerate the icon whenever the source PNG is newer, so editing
		// icon-dev.png is enough to reskin the dev app.
		let iconCurrent = false;
		try {
			iconCurrent =
				statSync(resolve(ELECTRON_APP_PATH, "Contents/Resources/electron.icns"))
					.mtimeMs >= statSync(DEV_ICON_PNG).mtimeMs;
		} catch {}

		if (
			currentBundleId === BUNDLE_ID &&
			currentScheme === PROTOCOL_SCHEME &&
			currentName === DISPLAY_NAME &&
			isRenamed &&
			pathTxtCorrect &&
			iconCurrent &&
			hasValidSignature(ELECTRON_APP_PATH)
		) {
			registerWithLaunchServices(
				resolve(ELECTRON_DIST_DIR, DEV_APP_BUNDLE_NAME),
			);
			console.log(
				`[patch-dev-protocol] ${PROTOCOL_SCHEME}:// already registered`,
			);
			process.exit(0);
		}
	} catch {}

	console.log(
		`[patch-dev-protocol] Registering ${PROTOCOL_SCHEME}:// scheme...`,
	);

	execSync(
		`/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${BUNDLE_ID}" "${PLIST_PATH}"`,
	);

	// CFBundleName exists in default Electron plist, so Set works
	execSync(
		`/usr/libexec/PlistBuddy -c "Set :CFBundleName ${DISPLAY_NAME}" "${PLIST_PATH}"`,
	);

	// CFBundleDisplayName may not exist — delete then add to handle both cases
	try {
		execSync(
			`/usr/libexec/PlistBuddy -c "Delete :CFBundleDisplayName" "${PLIST_PATH}" 2>/dev/null`,
		);
	} catch {}
	execSync(
		`/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string '${DISPLAY_NAME}'" "${PLIST_PATH}"`,
	);

	// Remove existing URL types to avoid stale entries from previous patches
	try {
		execSync(
			`/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "${PLIST_PATH}" 2>/dev/null`,
		);
	} catch {}

	const commands = [
		`Add :CFBundleURLTypes array`,
		`Add :CFBundleURLTypes:0 dict`,
		`Add :CFBundleURLTypes:0:CFBundleURLName string 'Odin Dev'`,
		`Add :CFBundleURLTypes:0:CFBundleURLSchemes array`,
		`Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string '${PROTOCOL_SCHEME}'`,
		`Add :CFBundleURLTypes:0:CFBundleTypeRole string 'Editor'`,
	];

	for (const cmd of commands) {
		execSync(`/usr/libexec/PlistBuddy -c "${cmd}" "${PLIST_PATH}"`);
	}

	// Renaming the bundle invalidates any terminal-host daemon still running out
	// of it: the daemon is detached and long-lived, and it forks pty-subprocess.js
	// from the execPath it captured at startup, so every NEW session would die
	// with ENOENT while already-attached ones kept working. Retire it here and
	// the app respawns it from the new path on the next connect.
	//
	// Not hypothetical: `bun install` restores dist/Electron.app, so the next dev
	// run renames again and breaks whatever daemon was alive.
	// Uses the pid the daemon records, not `pkill -f`: once the executable has
	// moved, pgrep/pkill stop seeing the process at all (measured — pgrep listed
	// 3 of the 6 processes ps reported, dropping the daemon), and this runs at
	// exactly that moment.
	const retireDaemonUnder = (bundlePath: string) => {
		try {
			const pid = Number(
				readFileSync(
					resolve(homedir(), ".odin/terminal-host.pid"),
					"utf-8",
				).trim(),
			);
			if (!Number.isInteger(pid) || pid <= 1) return;
			// Only ours: a packaged daemon lives under /Applications and is fine.
			const argv = execSync(`ps -p ${pid} -ww -o command=`, {
				encoding: "utf-8",
			}).trim();
			if (!argv.startsWith(bundlePath)) return;
			process.kill(pid, "SIGTERM");
			console.log(
				"[patch-dev-protocol] Retired the terminal-host daemon (its binary moved)",
			);
		} catch {
			// No pid file, dead pid, or ps had nothing to say — nothing to retire.
		}
	};

	// Rename Electron.app so macOS uses our display name for the dock label.
	// The plist CFBundleName is set correctly, but Electron's runtime overrides
	// the in-memory value before the dock reads it. Renaming the .app bundle
	// ensures macOS sees the correct name from the bundle directory itself.
	// A symlink preserves backward compatibility for the `electron` npm package.
	const DESIRED_APP_NAME = DEV_APP_BUNDLE_NAME;
	const desiredAppPath = resolve(ELECTRON_DIST_DIR, DESIRED_APP_NAME);
	let actualAppPath = ELECTRON_APP_PATH;

	try {
		const stats = lstatSync(ELECTRON_APP_PATH);

		if (stats.isSymbolicLink()) {
			const currentTarget = readlinkSync(ELECTRON_APP_PATH);
			if (currentTarget === DESIRED_APP_NAME) {
				// Already correctly renamed
				actualAppPath = desiredAppPath;
			} else {
				// Different workspace name from previous run — update
				const oldTargetPath = resolve(ELECTRON_DIST_DIR, currentTarget);
				retireDaemonUnder(oldTargetPath);
				unlinkSync(ELECTRON_APP_PATH);
				if (existsSync(oldTargetPath)) {
					renameSync(oldTargetPath, desiredAppPath);
				}
				symlinkSync(DESIRED_APP_NAME, ELECTRON_APP_PATH);
				actualAppPath = desiredAppPath;
			}
		} else {
			// Real directory — rename and create symlink
			retireDaemonUnder(ELECTRON_APP_PATH);
			if (existsSync(desiredAppPath)) {
				rmSync(desiredAppPath, { recursive: true });
			}
			renameSync(ELECTRON_APP_PATH, desiredAppPath);
			symlinkSync(DESIRED_APP_NAME, ELECTRON_APP_PATH);
			actualAppPath = desiredAppPath;
		}

		console.log(
			`[patch-dev-protocol] Renamed Electron.app to ${DESIRED_APP_NAME}`,
		);
	} catch (err) {
		console.warn("[patch-dev-protocol] Failed to rename Electron.app:", err);
	}

	// Icon first, signature last: the seal covers Contents/Resources, so anything
	// written afterwards invalidates it again.
	try {
		writeBundleIcon(actualAppPath);
		console.log("[patch-dev-protocol] Applied the Odin dev bundle icon");
	} catch (err) {
		console.warn("[patch-dev-protocol] Failed to apply the bundle icon:", err);
	}

	try {
		const identity = signingIdentity();
		execSync(
			`/usr/bin/codesign --force --sign ${identity} "${actualAppPath}"`,
			{
				stdio: "ignore",
			},
		);
		console.log(
			`[patch-dev-protocol] Re-signed the patched bundle (${identity})`,
		);
	} catch (err) {
		console.warn("[patch-dev-protocol] Failed to re-sign the bundle:", err);
	}

	registerWithLaunchServices(actualAppPath);

	// usernoted snapshots an app's icon the first time it sees the bundle ID and
	// never re-reads it, so a bundle whose icon was still Electron's at first
	// launch keeps drawing the atom on every banner no matter what Launch
	// Services resolves afterwards. launchd brings it straight back.
	try {
		execSync("/usr/bin/killall usernoted");
		console.log(
			"[patch-dev-protocol] Bounced usernoted to drop its icon cache",
		);
	} catch {
		// Not running, or already restarting — either way the cache is gone.
	}

	// Update the electron package's path.txt so electron-vite launches from the
	// renamed .app directly (not through the Electron.app symlink). This ensures
	// the invocation path contains the correct app name for macOS bundle resolution.
	const electronPkgDir = resolve(
		import.meta.dirname,
		"../node_modules/electron",
	);
	const pathTxtPath = resolve(electronPkgDir, "path.txt");
	const desiredPathTxt = `${DESIRED_APP_NAME}/Contents/MacOS/Electron`;
	try {
		writeFileSync(pathTxtPath, desiredPathTxt);
		console.log(
			`[patch-dev-protocol] Updated path.txt to use ${DESIRED_APP_NAME}`,
		);
	} catch (err) {
		console.warn("[patch-dev-protocol] Failed to update path.txt:", err);
	}

	return { worktreePath, workspaceName };
}

if (import.meta.main) {
	main();
}
