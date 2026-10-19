import { describe, expect, it } from "bun:test";
import { menuTop } from "./menu-fit";

describe("menuTop", () => {
	it("opens at the click when the whole menu fits below it", () => {
		expect(menuTop(100, 440, 900)).toBe(100);
	});

	it("moves up so the bottom stays on screen - the New tag field was off it", () => {
		// 600px window, right-click at 500: a 440px menu ends at 940.
		expect(menuTop(500, 440, 600)).toBe(600 - 440 - 8);
	});

	it("never goes above the margin when the menu is taller than the window", () => {
		expect(menuTop(500, 800, 600)).toBe(8);
	});
});
