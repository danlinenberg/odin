import { describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({ app: { isPackaged: false } }));

const { iconCacheIsStale } = await import("./notification-icon-cache");

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
