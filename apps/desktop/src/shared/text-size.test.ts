import { expect, test } from "bun:test";
import {
	browserZoomFor,
	DEFAULT_TEXT_SIZE,
	TEXT_SIZE_MAX,
	TEXT_SIZE_MIN,
	TEXT_SIZE_STEP,
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
	expect(textSizeOf("1.2")).toBe(DEFAULT_TEXT_SIZE);
	expect(textSizeOf(Number.NaN)).toBe(DEFAULT_TEXT_SIZE);
	expect(textSizeOf(7)).toBe(DEFAULT_TEXT_SIZE);
	expect(textSizeOf(1.25)).toBe(1.25);
	expect(windowZoomFor(4.5, 1, 1.5)).toBe(5);
});

test("a stored text size snaps to the slider's 5% steps", () => {
	expect(textSizeOf(1.03)).toBe(1.05);
	expect(textSizeOf(1.12)).toBe(1.1);
	expect(textSizeOf(1.3)).toBe(1.3);
	// A step reads back as itself, not as 1.0500000000000003.
	expect(textSizeOf(1.05)).toBe(1.05);
	expect(textSizeOf(0.95)).toBe(0.95);
});

test("the slider's ends are text sizes, and anything past them reads as the default", () => {
	expect(textSizeOf(TEXT_SIZE_MIN)).toBe(TEXT_SIZE_MIN);
	expect(textSizeOf(TEXT_SIZE_MAX)).toBe(TEXT_SIZE_MAX);
	expect(textSizeOf(TEXT_SIZE_MIN - TEXT_SIZE_STEP)).toBe(DEFAULT_TEXT_SIZE);
	expect(textSizeOf(TEXT_SIZE_MAX + TEXT_SIZE_STEP)).toBe(DEFAULT_TEXT_SIZE);
});
