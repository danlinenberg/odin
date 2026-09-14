import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEV_APP_BUNDLE_NAME,
	deriveWorktreePathFromSegments,
	devBundleId,
	getWorktreeSegmentsFromCwd,
	hasValidSignature,
	resolveWorkspaceIdentity,
	signingIdentity,
	writeBundleIcon,
} from "./patch-dev-protocol";

const WORKTREE_BASE = join("/tmp", "odin-worktrees");

describe("patch-dev-protocol workspace resolution", () => {
	it("derives worktree segments from a desktop worktree cwd", () => {
		const cwd = join(
			WORKTREE_BASE,
			"odin",
			"kitenite",
			"feature-2058",
			"apps",
			"desktop",
		);

		expect(getWorktreeSegmentsFromCwd(cwd, WORKTREE_BASE)).toEqual([
			"odin",
			"kitenite",
			"feature-2058",
			"apps",
			"desktop",
		]);
	});

	it("derives the worktree path without the apps/desktop suffix", () => {
		expect(
			deriveWorktreePathFromSegments(
				["odin", "kitenite", "feature-2058", "apps", "desktop"],
				WORKTREE_BASE,
			),
		).toBe(join(WORKTREE_BASE, "odin", "kitenite", "feature-2058"));
	});

	it("prefers the path-derived workspace name over a stale env value", () => {
		const identity = resolveWorkspaceIdentity({
			cwd: join(WORKTREE_BASE, "odin", "feature-2058", "apps", "desktop"),
			envWorkspaceName: "stale-env-name",
			worktreeBase: WORKTREE_BASE,
		});

		expect(identity.workspaceName).toBe("feature-2058");
		expect(identity.displayWorkspaceName).toBe("feature-2058");
		expect(identity.bundleDisplayWorkspaceName).toBe("feature-2058");
	});

	it("prefers the prod DB display name and sanitizes it for the bundle name", () => {
		const worktreePath = join(WORKTREE_BASE, "odin", "feature-2058");
		const identity = resolveWorkspaceIdentity({
			cwd: join(worktreePath, "apps", "desktop"),
			envWorkspaceName: "feature-2058",
			worktreeBase: WORKTREE_BASE,
			lookupDisplayName: (path) =>
				path === worktreePath ? "Team/Alias" : undefined,
		});

		expect(identity.workspaceName).toBe("feature-2058");
		expect(identity.displayWorkspaceName).toBe("Team/Alias");
		expect(identity.bundleDisplayWorkspaceName).toBe("Team-Alias");
	});

	it("falls back to the env workspace name outside the worktree root", () => {
		const identity = resolveWorkspaceIdentity({
			cwd: join("/tmp", "not-a-worktree"),
			envWorkspaceName: "env-workspace",
			worktreeBase: WORKTREE_BASE,
		});

		expect(identity.workspaceName).toBe("env-workspace");
		expect(identity.displayWorkspaceName).toBe("env-workspace");
		expect(identity.bundleDisplayWorkspaceName).toBe("env-workspace");
		expect(identity.worktreePath).toBeUndefined();
	});

	// Two checkouts can share a workspace name (a copied .env does it), and a
	// shared bundle ID means macOS may draw the other bundle's icon and name on
	// this app's notifications.
	it("gives each checkout its own bundle ID", () => {
		const mine = devBundleId(
			"/Users/x/odin/apps/desktop/node_modules/electron/dist",
		);
		const theirs = devBundleId(
			"/Users/x/odin-2/apps/desktop/node_modules/electron/dist",
		);

		expect(mine).not.toBe(theirs);
		expect(mine).toBe(
			devBundleId("/Users/x/odin/apps/desktop/node_modules/electron/dist"),
		);
		expect(mine).toMatch(/^com\.odin\.desktop\.dev\.[0-9a-f]{10}$/);
	});

	// The identity is interpolated into a codesign command line, so a bare
	// multi-word name would silently sign as ad-hoc and wipe the TCC grants.
	it("returns a shell-safe signing identity", () => {
		const identity = signingIdentity();

		expect(identity === "-" || identity.startsWith('"')).toBe(true);
	});
});

// The two halves of the bundle's macOS identity: the icon notification banners
// draw, and the signature that lets macOS resolve the app's name at all.
describe.if(process.platform === "darwin")(
	"patch-dev-protocol branding",
	() => {
		function makeBundle(): string {
			const appPath = join(
				mkdtempSync(join(tmpdir(), "odin-bundle-")),
				"T.app",
			);
			mkdirSync(join(appPath, "Contents/MacOS"), { recursive: true });
			mkdirSync(join(appPath, "Contents/Resources"), { recursive: true });
			copyFileSync("/bin/echo", join(appPath, "Contents/MacOS/T"));
			execSync(
				`/usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string T" -c "Add :CFBundleIdentifier string com.odin.test" -c "Add :CFBundleIconFile string electron.icns" "${appPath}/Contents/Info.plist"`,
			);
			return appPath;
		}

		it("writes an icns the bundle can use as its icon", () => {
			const appPath = makeBundle();
			writeBundleIcon(appPath);

			const icns = join(appPath, "Contents/Resources/electron.icns");
			expect(statSync(icns).size).toBeGreaterThan(0);
			expect(
				execSync(`/usr/bin/file "${icns}"`, { encoding: "utf-8" }),
			).toContain("Mac OS X icon");
		});

		it("reports the signature invalid until the bundle is re-signed", () => {
			const appPath = makeBundle();
			writeBundleIcon(appPath);
			expect(hasValidSignature(appPath)).toBe(false);

			execSync(`/usr/bin/codesign --force --sign - "${appPath}"`);
			expect(hasValidSignature(appPath)).toBe(true);
		});
	},
);

describe("dev bundle Launch Services entry", () => {
	// The registration only lives while the dev stack runs, so odin-dev.sh has to
	// name the very bundle patch-dev-protocol renames. Rename the dev app and
	// forget the script, and the stale entry comes back: opening "Odin Dev" from
	// Spotlight launches a bare Electron with no app path, i.e. the welcome screen.
	it("odin-dev.sh unregisters the bundle patch-dev-protocol registers", () => {
		const script = readFileSync(
			join(import.meta.dirname, "../../../scripts/odin-dev.sh"),
			"utf-8",
		);

		expect(script).toContain(`electron/dist/${DEV_APP_BUNDLE_NAME}`);
		expect(script).toContain("lsregister");
	});
});
