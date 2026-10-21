import { describe, expect, test } from "bun:test";
import {
	clampSessionListWidth,
	DEFAULT_SESSION_LIST_W,
	FULL_CONTROLS_MIN_W,
	ICON_CONTROLS_MIN_W,
	loadSessionListWidth,
	MIN_SESSION_LIST_W,
	maxSessionListWidth,
	SESSION_LIST_WIDTH_KEY,
	saveSessionListWidth,
	sessionListControls,
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
	test("the default sits inside the range", () => {
		expect(DEFAULT_SESSION_LIST_W).toBeGreaterThanOrEqual(MIN_SESSION_LIST_W);
		// The narrowest panel the list shows in is 768px (@3xl).
		expect(DEFAULT_SESSION_LIST_W).toBeLessThanOrEqual(
			maxSessionListWidth(768),
		);
	});
});

describe("sessionListControls", () => {
	test("wide enough for the worded buttons and the longest sort label", () => {
		expect(sessionListControls(FULL_CONTROLS_MIN_W)).toBe("full");
		expect(sessionListControls(480)).toBe("full");
	});

	test("narrower, Group and Select turn into icons", () => {
		expect(sessionListControls(FULL_CONTROLS_MIN_W - 1)).toBe("icons");
		expect(sessionListControls(ICON_CONTROLS_MIN_W)).toBe("icons");
	});

	test("narrower still, the sort labels go short too", () => {
		expect(sessionListControls(ICON_CONTROLS_MIN_W - 1)).toBe("tight");
		expect(sessionListControls(MIN_SESSION_LIST_W)).toBe("tight");
	});

	test("the default width shows icons with the full sort labels", () => {
		expect(sessionListControls(DEFAULT_SESSION_LIST_W)).toBe("icons");
	});
});

describe("maxSessionListWidth", () => {
	test("half the panel", () => {
		expect(maxSessionListWidth(1000)).toBe(500);
		expect(maxSessionListWidth(801)).toBe(400);
	});

	test("never under the minimum, however narrow the panel", () => {
		expect(maxSessionListWidth(200)).toBe(MIN_SESSION_LIST_W);
	});

	test("an unmeasured panel sets no maximum", () => {
		expect(maxSessionListWidth(Number.POSITIVE_INFINITY)).toBe(
			Number.POSITIVE_INFINITY,
		);
	});
});

describe("clampSessionListWidth", () => {
	test("a width inside the range is kept, rounded to a pixel", () => {
		expect(clampSessionListWidth(300.4, 1200)).toBe(300);
	});

	test("too narrow stops at the minimum", () => {
		expect(clampSessionListWidth(20, 1200)).toBe(MIN_SESSION_LIST_W);
	});

	test("too wide stops at half the panel, and follows the panel", () => {
		expect(clampSessionListWidth(5000, 1200)).toBe(600);
		expect(clampSessionListWidth(500, 800)).toBe(400);
		expect(clampSessionListWidth(500, 1400)).toBe(500);
	});

	test("with no panel only the minimum applies", () => {
		expect(clampSessionListWidth(900)).toBe(900);
		expect(clampSessionListWidth(20)).toBe(MIN_SESSION_LIST_W);
	});

	test("a width that is not a number falls back to the default", () => {
		expect(clampSessionListWidth(Number.NaN, 1200)).toBe(
			DEFAULT_SESSION_LIST_W,
		);
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

	test("a saved width wider than this panel allows is kept, only shown clamped", () => {
		const storage = memoryStorage();
		saveSessionListWidth(storage, 700);
		expect(loadSessionListWidth(storage)).toBe(700);
		expect(clampSessionListWidth(loadSessionListWidth(storage), 1000)).toBe(
			500,
		);
		expect(storage.getItem(SESSION_LIST_WIDTH_KEY)).toBe("700");
	});

	test("a saved width too narrow or garbled is fixed on read", () => {
		const storage = memoryStorage();
		storage.setItem(SESSION_LIST_WIDTH_KEY, "40");
		expect(loadSessionListWidth(storage)).toBe(MIN_SESSION_LIST_W);
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
