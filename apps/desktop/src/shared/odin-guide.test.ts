import { describe, expect, it } from "bun:test";
import { ODIN_GUIDE, odinGuide } from "./odin-guide";

describe("odinGuide", () => {
	it("returns the whole guide without a word", () => {
		expect(odinGuide()).toBe(ODIN_GUIDE);
	});

	it("returns only the sections that mention the word", () => {
		const night = odinGuide("battery");
		expect(night).toContain("## Night Agent");
		expect(night).not.toContain("## Insights");
	});

	it("lists the sections when nothing matches", () => {
		expect(odinGuide("zzqx")).toContain("Sections: ");
	});
});
