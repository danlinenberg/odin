import { describe, expect, test } from "bun:test";
import {
	clampSessionListWidth,
	DEFAULT_SESSION_LIST_W,
	loadSessionListWidth,
	MAX_SESSION_LIST_W,
	MIN_SESSION_LIST_W,
	SESSION_LIST_WIDTH_KEY,
	saveSessionListWidth,
} from "./session-list-width";

function memoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (key) => map.get(key) ?? null,
		key: (i) => [...map.keys()][i] ?? null,
		removeItem: (key) => {
			map.delete(key);
		},
		setItem: (key, value) => {
			map.set(key, value);
		},
	};
}

describe("the width range", () => {
	// Measured in the built app: the sort select (112px at its widest pick),
	// Group and Select, their gaps and the row's padding need 239px.
	const CONTROLS_FIT_W = 239;

	test("the header controls fit at the minimum, nothing cut off", () => {
		expect(MIN_SESSION_LIST_W).toBeGreaterThanOrEqual(CONTROLS_FIT_W);
	});

	test("the default sits inside the range", () => {
		expect(DEFAULT_SESSION_LIST_W).toBeGreaterThanOrEqual(MIN_SESSION_LIST_W);
		expect(DEFAULT_SESSION_LIST_W).toBeLessThanOrEqual(MAX_SESSION_LIST_W);
		expect(MAX_SESSION_LIST_W).toBe(480);
	});
});

describe("clampSessionListWidth", () => {
	test("a width inside the range is kept, rounded to a pixel", () => {
		expect(clampSessionListWidth(300.4)).toBe(300);
	});

	test("too narrow stops at the minimum, too wide at the maximum", () => {
		expect(clampSessionListWidth(20)).toBe(MIN_SESSION_LIST_W);
		expect(clampSessionListWidth(5000)).toBe(MAX_SESSION_LIST_W);
	});

	test("a width that is not a number falls back to the default", () => {
		expect(clampSessionListWidth(Number.NaN)).toBe(DEFAULT_SESSION_LIST_W);
	});
});

describe("session list width storage", () => {
	test("nothing saved reads as the default", () => {
		expect(loadSessionListWidth(memoryStorage())).toBe(DEFAULT_SESSION_LIST_W);
	});

	test("a dragged width survives a reload", () => {
		const storage = memoryStorage();
		saveSessionListWidth(storage, 320);
		expect(loadSessionListWidth(storage)).toBe(320);
	});

	test("a saved width out of range or garbled is clamped on read", () => {
		const storage = memoryStorage();
		storage.setItem(SESSION_LIST_WIDTH_KEY, "9999");
		expect(loadSessionListWidth(storage)).toBe(MAX_SESSION_LIST_W);
		storage.setItem(SESSION_LIST_WIDTH_KEY, "wide");
		expect(loadSessionListWidth(storage)).toBe(DEFAULT_SESSION_LIST_W);
	});

	test("resetting to the default removes the key", () => {
		const storage = memoryStorage();
		saveSessionListWidth(storage, 320);
		saveSessionListWidth(storage, DEFAULT_SESSION_LIST_W);
		expect(storage.getItem(SESSION_LIST_WIDTH_KEY)).toBeNull();
	});

	test("storage that throws reads as the default and saves nothing", () => {
		const broken = {
			...memoryStorage(),
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
		} as Storage;
		expect(loadSessionListWidth(broken)).toBe(DEFAULT_SESSION_LIST_W);
		expect(() => saveSessionListWidth(broken, 300)).not.toThrow();
	});
});
