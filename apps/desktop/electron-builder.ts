/**
 * Electron Builder Configuration
 * @see https://www.electron.build/configuration/configuration
 */

import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Configuration } from "electron-builder";
import pkg from "./package.json";
import {
	packagedAsarUnpackGlobs,
	packagedNodeModuleCopies,
} from "./runtime-dependencies";

const currentYear = new Date().getFullYear();
const author = pkg.author?.name ?? pkg.author;
const productName = pkg.productName;
const macIconPath = join(pkg.resources, "build/icons/icon.icns");
const dmgBackgroundPath = join(
	pkg.resources,
	"build/installer/background.tiff",
);

const config: Configuration = {
	// Source maps are built for Sentry and for validate-native-runtime, both of
	// which have already run by the time packaging starts. A negated .map entry
	// in `files` only filters the node_modules electron-builder collects on its
	// own — files pulled in by an explicit dist pattern ignore it, and 92 MB of
	// maps shipped anyway. Deleting them here catches every packaging path, and
	// the next build regenerates them.
	//
	// Line comments on purpose: a glob written inside a block comment ends it
	// early, because the slash-star-star-slash form contains the terminator.
	beforePack: async () => {
		// Relative, like pkg.resources above: electron-builder runs from the app
		// directory.
		const entries = await readdir("dist", { recursive: true });
		const maps = entries.filter((entry) => entry.endsWith(".map"));
		await Promise.all(maps.map((file) => rm(join("dist", file), { force: true })));
		console.log(`beforePack: removed ${maps.length} source maps from dist`);
	},

	// Odin fork: distinct identity so it never collides with the installed
	// Odin app, and no update feed — upstream's updater would otherwise
	// "update" Odin back into stock Odin.
	appId: "com.dan.odin",
	productName,
	copyright: `Copyright © ${currentYear} — ${author}`,
	electronVersion: pkg.devDependencies.electron.replace(/^\^/, ""),

	// Directories
	directories: {
		output: "release",
		buildResources: join(pkg.resources, "build"),
	},

	// ASAR configuration for native modules and external resources
	asar: true,
	asarUnpack: [
		...packagedAsarUnpackGlobs,
		// Sound files must be unpacked so external audio players (afplay, paplay, etc.) can access them
		"**/resources/sounds/**/*",
		// Tray icon must be unpacked so Electron Tray can load it
		"**/resources/tray/**/*",
	],

	// Extra resources placed outside asar archive (accessible via process.resourcesPath)
	extraResources: [
		// Database migrations - must be outside asar for drizzle-orm to read
		{
			from: "dist/resources/migrations",
			to: "resources/migrations",
			filter: ["**/*"],
		},
		{
			from: "dist/resources/host-migrations",
			to: "resources/host-migrations",
			filter: ["**/*"],
		},
		{
			from: "dist/resources/bin",
			to: "resources/bin",
			filter: ["**/*"],
		},
	],

	files: [
		"dist/**/*",
		"package.json",
		{
			from: pkg.resources,
			to: "resources",
			filter: ["**/*"],
		},
		// Runtime modules that stay external to the main bundle.
		// bun creates symlinks for direct deps in workspace node_modules.
		// The copy:native-modules script replaces symlinks with real files
		// before building (required for Bun 1.3+ isolated installs).
		...packagedNodeModuleCopies,
		"!**/.DS_Store",

		// Source maps are built for Sentry and for validate-native-runtime, and
		// then ride into the app where nothing reads them: 486 MB of the payload.
		"!**/*.map",

		// A macOS arm64 app cannot load a Linux .so, a Windows .dll or an x64
		// dylib, but every multi-platform package ships the full set anyway.
		"!**/node_modules/onnxruntime-node/bin/napi-v3/{linux,win32}/**",
		"!**/node_modules/onnxruntime-node/bin/napi-v3/darwin/x64/**",
		"!**/node_modules/koffi/build/koffi/{darwin_x64,freebsd_*,linux_*,netbsd_*,openbsd_*,win32_*}/**",
		"!**/node_modules/**/prebuilds/{android-*,darwin-x64,freebsd-*,linux-*,win32-*}/**",
		"!**/node_modules/node-pty/third_party/**",

		// electron-builder copies every production dependency, but the packaged
		// bundles require only eleven modules at runtime: electron, better-sqlite3,
		// node-pty, @parcel/watcher, native-keymap, @odin/macos-process-metrics,
		// mastracode, ajv, iconv-lite, zod and esprima. Everything below is a
		// renderer library that vite already compiled into dist/renderer — and the
		// renderer is a browser context, so it could not require one of these even
		// if it wanted to. 614 MB of the app was these libraries a second time.
		//
		// To re-derive the list: scan dist/**/*.js for require("<bare-specifier>"),
		// walk dependencies from those roots, and take what the walk never reaches.
		"!**/node_modules/react-icons/**",
		"!**/node_modules/mermaid/**",
		"!**/node_modules/@mermaid-js/parser/**",
		"!**/node_modules/emojibase-data/**",
		"!**/node_modules/posthog-js/**",
		"!**/node_modules/lucide-react/**",
		"!**/node_modules/@linear/sdk/**",
		"!**/node_modules/date-fns/**",
		"!**/node_modules/date-fns-jalali/**",
		"!**/node_modules/prettier/**",
		"!**/node_modules/cytoscape/**",
		"!**/node_modules/cytoscape-fcose/**",
		"!**/node_modules/@ai-sdk/react/**",
		"!**/node_modules/@shikijs/langs/**",
		"!**/node_modules/react-dom/**",
		"!**/node_modules/@tanstack/db/**",

		// Nothing in the repo declares @anthropic-ai/claude-agent-sdk and nothing
		// reaches it; Odin drives the agent CLI already on your PATH. Its vendored
		// copy of the claude binary was the single largest file in the app.
		"!**/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/**",
	],

	// Rebuild native modules for Electron's Node.js version
	npmRebuild: true,

	// macOS DMG installer
	dmg: {
		...(existsSync(dmgBackgroundPath) ? { background: dmgBackgroundPath } : {}),
		// Explicit size — dmgbuild's auto-calc under-allocates and silently truncates
		// the last large file above ~1.7GB of contents. `shrink: true` (default) keeps
		// the final artifact compact.
		size: "4g",
	},

	// macOS
	mac: {
		...(existsSync(macIconPath) ? { icon: macIconPath } : {}),
		category: "public.app-category.utilities",
		// arm64 only, to match the release workflow and the cask's
		// `depends_on arch: :arm64`. The `files` excludes above strip the
		// darwin-x64 native prebuilds, so an x64 build would package cleanly and
		// then fail to load node-pty at runtime — better to refuse the arch here.
		target: [{ target: "default", arch: ["arm64"] }],
		hardenedRuntime: true,
		gatekeeperAssess: false,
		// Signed with the stable self-signed cert from
		// scripts/create-signing-identity.sh. Ad-hoc signing gave every build a
		// new signature, and macOS keys privacy grants to the signature — so every
		// rebuild wiped the permissions and re-prompted. Notarization needs a real
		// Developer ID, which this fork doesn't have and doesn't need: locally
		// built apps aren't quarantined, so Gatekeeper never inspects them.
		identity: "Odin Local Signing",
		notarize: false,
		entitlements: join(pkg.resources, "build/entitlements.mac.plist"),
		entitlementsInherit: join(
			pkg.resources,
			"build/entitlements.mac.inherit.plist",
		),
		extendInfo: {
			CFBundleName: productName,
			CFBundleDisplayName: productName,
			// Required for Apple Events / Automation permission prompt
			NSAppleEventsUsageDescription:
				"Odin needs to interact with other applications to run terminal commands and development tools.",
			// File-access prompts. Without these macOS shows a bare
			// "would like to access…" dialog with no reason at all.
			NSDesktopFolderUsageDescription:
				"Odin needs access to your Desktop so projects and worktrees stored there can be opened.",
			NSDocumentsFolderUsageDescription:
				"Odin needs access to your Documents so projects and worktrees stored there can be opened.",
			NSDownloadsFolderUsageDescription:
				"Odin needs access to your Downloads so projects and worktrees stored there can be opened.",
			NSNetworkVolumesUsageDescription:
				"Odin needs access to network volumes so projects stored on network shares can be opened.",
			NSRemovableVolumesUsageDescription:
				"Odin needs access to removable volumes so projects stored on external drives can be opened.",
		},
	},

	// Deep linking protocol — Odin's own scheme, never the installed
	// Odin's, or OAuth callbacks open the wrong app.
	protocols: {
		name: productName,
		schemes: ["odin"],
	},
};

export default config;
