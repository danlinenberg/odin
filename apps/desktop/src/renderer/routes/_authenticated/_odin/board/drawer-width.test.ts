import { expect, test } from "bun:test";
import {
	DEFAULT_DRAWER_FRACTIONS,
	loadDrawerFractions,
	saveDrawerFractions,
} from "./drawer-width";

const memoryStorage = (): Storage => {
	const items = new Map<string, string>();
	return {
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) => void items.set(key, value),
		removeItem: (key) => void items.delete(key),
		clear: () => items.clear(),
		key: () => null,
		get length() {
			return items.size;
		},
	};
};

test("the list and Today keep their own drawer width", () => {
	const storage = memoryStorage();
	expect(loadDrawerFractions(storage)).toEqual(DEFAULT_DRAWER_FRACTIONS);
	saveDrawerFractions(storage, { list: 1, today: 0.5 });
	expect(loadDrawerFractions(storage)).toEqual({ list: 1, today: 0.5 });
});

test("a bad or out-of-range saved width falls back or clamps", () => {
	const storage = memoryStorage();
	storage.setItem("odin:drawer-width", "not json");
	expect(loadDrawerFractions(storage)).toEqual(DEFAULT_DRAWER_FRACTIONS);
	storage.setItem("odin:drawer-width", JSON.stringify({ list: 3, today: "x" }));
	expect(loadDrawerFractions(storage)).toEqual({
		list: 1,
		today: DEFAULT_DRAWER_FRACTIONS.today,
	});
});
