import { describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({ app: { isPackaged: false } }));

const { iconCacheIsStale, parkedBundles } = await import(
	"./notification-icon-cache"
);

describe("iconCacheIsStale", () => {
	test("no stamp yet counts as stale, so an existing install refreshes once", () => {
		expect(iconCacheIsStale("abc", null)).toBe(true);
	});

	test("a stamp for another icon is stale", () => {
		expect(iconCacheIsStale("abc", "def\n")).toBe(true);
	});

	test("a stamp for this icon is not", () => {
		expect(iconCacheIsStale("abc", "abc\n")).toBe(false);
	});
});

describe("parkedBundles", () => {
	test("finds bundles parked in any Odin home's stale folder, once each", () => {
		const dump = [
			"path:          /Applications/Odin.app (0x1a2b)",
			"identifier:    com.dan.odin",
			"path:          /Users/dan/.odin-prodtest/.odin/stale/Odin-1791303751.app (0x3c4d)",
			"identifier:    com.dan.odin",
			"path:          /Users/dan/.odin/stale/Odin-1792868106.app",
			"path:          /Users/dan/.odin/stale/Odin-1792868106.app (0x5e6f)",
			"path:          /Users/dan/dev/odin/apps/desktop/release/mac-arm64/Odin.app (0x7a8b)",
		].join("\n");
		expect(parkedBundles(dump)).toEqual([
			"/Users/dan/.odin-prodtest/.odin/stale/Odin-1791303751.app",
			"/Users/dan/.odin/stale/Odin-1792868106.app",
		]);
	});
});
