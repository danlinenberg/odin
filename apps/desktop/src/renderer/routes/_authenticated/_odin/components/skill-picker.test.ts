import { describe, expect, test } from "bun:test";
import { insertSkill, matchSkills, skillToken } from "./skill-picker";

const SKILLS = [
	{ name: "gdpr", description: "Audit deletion tickets" },
	{ name: "imagen-core:data", description: "Query SQL and MongoDB" },
	{ name: "ship-status", description: "A/B test ship status from Mixpanel" },
];

describe("skillToken", () => {
	test("opens on a slash token at the end", () => {
		expect(skillToken("/")).toBe("");
		expect(skillToken("/gd")).toBe("gd");
		expect(skillToken("check the /imagen-core:da")).toBe("imagen-core:da");
	});

	test("stays closed otherwise", () => {
		expect(skillToken("")).toBeUndefined();
		expect(skillToken("/gdpr then do the thing")).toBeUndefined();
		// A path, not a command
		expect(skillToken("apps/desktop/src")).toBeUndefined();
	});
});

describe("matchSkills", () => {
	test("matches names, then descriptions", () => {
		expect(matchSkills(SKILLS, "gdpr").map((s) => s.name)).toEqual(["gdpr"]);
		expect(matchSkills(SKILLS, "mongo").map((s) => s.name)).toEqual([
			"imagen-core:data",
		]);
	});

	test("name matches rank above description matches", () => {
		const hits = matchSkills(
			[
				{ name: "alpha", description: "mentions ship somewhere" },
				{ name: "ship-status", description: "unrelated words" },
			],
			"ship",
		);
		expect(hits.map((s) => s.name)).toEqual(["ship-status", "alpha"]);
	});

	test("is case-insensitive and capped", () => {
		expect(matchSkills(SKILLS, "GDPR")).toHaveLength(1);
		expect(matchSkills(SKILLS, "", 2)).toHaveLength(2);
	});
});

test("insertSkill replaces the typed token", () => {
	expect(insertSkill("/gd", "gdpr")).toBe("/gdpr ");
	expect(insertSkill("audit tickets /imagen", "imagen-core:data")).toBe(
		"audit tickets /imagen-core:data ",
	);
});
