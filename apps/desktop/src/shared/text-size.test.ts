import { expect, test } from "bun:test";
import {
	browserZoomFor,
	DEFAULT_TEXT_SIZE,
	textSizeOf,
	windowZoomFor,
} from "./text-size";

test("a bigger text size zooms the window, and the browser keeps its own zoom", () => {
	// ⌘+ once (110%), then text size 125%.
	const window = windowZoomFor(1.1, 1, 1.25);
	expect(window).toBeCloseTo(1.375);
	expect(browserZoomFor(window, 1.25)).toBeCloseTo(1.1);

	// Back to 100% text: the window is at the ⌘+ zoom again.
	expect(windowZoomFor(window, 1.25, 1)).toBeCloseTo(1.1);
});

test("an unknown stored text size reads as the default, and the zoom stays in Electron's range", () => {
	expect(textSizeOf(undefined)).toBe(DEFAULT_TEXT_SIZE);
	expect(textSizeOf(7)).toBe(DEFAULT_TEXT_SIZE);
	expect(textSizeOf(1.25)).toBe(1.25);
	expect(windowZoomFor(4.5, 1, 1.5)).toBe(5);
});
