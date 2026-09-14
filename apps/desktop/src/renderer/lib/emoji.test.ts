import { describe, expect, it } from "vitest";
import { emojify } from "./emoji";

describe("emojify", () => {
	it("replaces known shortcodes, back to back", () => {
		expect(emojify("can you help? :point_up::pray:")).toBe(
			"can you help? ☝️🙏",
		);
	});

	it("leaves unknown shortcodes and clock times alone", () => {
		expect(emojify("ship :not_an_emoji: by 12:30:45")).toBe(
			"ship :not_an_emoji: by 12:30:45",
		);
	});
});
