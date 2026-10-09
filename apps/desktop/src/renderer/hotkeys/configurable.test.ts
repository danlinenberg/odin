import { describe, expect, it } from "bun:test";
// biome-ignore lint/style/noRestrictedImports: test file needs fs/path for source verification
import { readdirSync, readFileSync } from "node:fs";
// biome-ignore lint/style/noRestrictedImports: test file needs fs/path for source verification
import { join, relative } from "node:path";
import { LISTED_HOTKEYS } from "./listed";
import { HOTKEYS } from "./registry";

// Every keyboard shortcut is rebindable: it lives in the registry, the code
// reads its binding (useHotkey / isHotkey / the menu's pushed chords), and
// Settings -> Keyboard lists it. Plain Enter, Esc, Tab and arrows inside a
// focused box or menu are how that widget works, not shortcuts - out of scope.

const REPO = join(import.meta.dir, "../../../../..");
const ROOTS = [
	"apps/desktop/src",
	"packages/ui/src",
	"packages/panes/src",
	"packages/shared/src",
	"packages/chat-legacy/src",
];

/** A key handler that decides on a chord itself instead of asking the registry. */
const HARDCODED = [
	/\b(metaKey|ctrlKey|altKey)\b/,
	/\buseHotkeys\(/,
	/\bkey === "[a-zA-Z0-9]"/,
	/\.code === "(Key|Digit)/,
	/accelerator:\s*["'`]/,
	/globalShortcut\.register\(/,
	/\binput\.(meta|control)\b/,
];

/** The registry's own matcher, dispatcher and recorder. */
const REGISTRY_DIR = "apps/desktop/src/renderer/hotkeys/";

/** Other files that may read modifiers, with how many lines do. A new line fails. */
const ALLOWED: Record<string, { lines: number; why: string }> = {
	"apps/desktop/src/renderer/lib/clickPolicy/policies/folderPolicy.ts": {
		lines: 1,
		why: "⌘-click, a mouse gesture",
	},
	"apps/desktop/src/renderer/lib/clickPolicy/tiers.ts": {
		lines: 1,
		why: "⌘-click, a mouse gesture",
	},
	"apps/desktop/src/renderer/lib/clickPolicy/types.ts": {
		lines: 2,
		why: "⌘-click, a mouse gesture",
	},
	"apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/helpers.ts":
		{ lines: 3, why: "⌘-click on a terminal link, a mouse gesture" },
	"packages/shared/src/terminal-wheel-handler/terminal-wheel-handler.ts": {
		lines: 8,
		why: "modifiers on a mouse wheel event, passed to the PTY",
	},
	"apps/desktop/src/renderer/lib/terminal/clipboard-shortcuts.ts": {
		lines: 16,
		why: "the OS copy / paste / select-all keys inside a terminal",
	},
	"apps/desktop/src/renderer/lib/terminal/line-edit-translations.ts": {
		lines: 5,
		why: "the OS text-caret keys (⌘←, ⌥⌫) inside a terminal",
	},
	"apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/hooks/useTerminalLifecycle.ts":
		{ lines: 3, why: "watches the Ctrl+C typed into the shell" },
	"packages/ui/src/components/ai-elements/prompt-input.tsx": {
		lines: 1,
		why: "keeps the text box's ⌘←/→ caret moves from bubbling",
	},
	"apps/desktop/src/renderer/routes/_authenticated/_odin/components/InAppBrowser.tsx":
		{
			lines: 3,
			why: "forwards a web page's chords to the registry check",
		},
	"apps/desktop/src/renderer/routes/_authenticated/settings/layout.tsx": {
		lines: 1,
		why: "plain Esc leaves Settings, like closing a dialog",
	},
	"apps/desktop/src/main/lib/global-new-task.ts": {
		lines: 1,
		why: "registers the ODIN_NEW_TASK binding system-wide",
	},
	"apps/desktop/src/main/lib/browser/browser-manager.ts": {
		lines: 3,
		why: "upstream browser panes; nothing in this shell registers one",
	},
};

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory())
			return entry.name === "node_modules" ? [] : sourceFiles(path);
		return /\.tsx?$/.test(entry.name) && !/\.(node-)?test\./.test(entry.name)
			? [path]
			: [];
	});
}

const files = ROOTS.flatMap((root) => sourceFiles(join(REPO, root))).map(
	(path) => ({
		path: relative(REPO, path),
		text: readFileSync(path, "utf8"),
	}),
);

describe("every keyboard shortcut is configurable", () => {
	it("decides on a chord only through the registry", () => {
		const offenders: string[] = [];
		for (const { path, text } of files) {
			if (path.startsWith(REGISTRY_DIR)) continue;
			const hits = text
				.split("\n")
				.filter((line) => HARDCODED.some((pattern) => pattern.test(line)));
			if (hits.length === (ALLOWED[path]?.lines ?? 0)) continue;
			offenders.push(`${path} (${hits.length} lines):\n  ${hits.join("\n  ")}`);
		}
		// If this fires: a key handler hardcodes its chord. Add a registry entry,
		// read it with useHotkey / isHotkey, and list it in listed.ts. A line
		// that really isn't a shortcut goes in ALLOWED with its count and why.
		expect(offenders).toEqual([]);
	});

	it("lists every hotkey the app binds in Settings -> Keyboard", () => {
		const listed = new Set<string>(LISTED_HOTKEYS);
		const skip =
			/hotkeys\/(registry|listed)\.ts$|settings\/keyboard\/page\.tsx$/;
		const unlisted = Object.keys(HOTKEYS).filter(
			(id) =>
				!listed.has(id) &&
				files.some(
					({ path, text }) =>
						!skip.test(path) && new RegExp(`["'\`]${id}["'\`]`).test(text),
				),
		);
		expect(unlisted).toEqual([]);
	});
});
