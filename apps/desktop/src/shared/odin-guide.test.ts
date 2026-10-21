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

	it("names Drop among the row actions, beside Done", () => {
		expect(ODIN_GUIDE).toMatch(
			/\*\*Row actions\*\*:.*\*\*Drop\*\*.*\*\*Done\*\*/,
		);
	});

	it("sends a question about the graveyard to All's Done shelf", () => {
		const all = odinGuide("graveyard");
		expect(all).toContain("## All");
		expect(all).toContain("Show what's Done");
	});
});
