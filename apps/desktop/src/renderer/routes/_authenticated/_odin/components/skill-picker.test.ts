import { describe, expect, test } from "bun:test";
import {
	BUILT_IN_COMMANDS,
	completeTaskSkill,
	enterPicks,
	insertSkill,
	matchSkills,
	skillToken,
	taskSkillToken,
} from "./skill-picker";

const SKILLS = [
	{ name: "gdpr", description: "Audit deletion tickets" },
	{ name: "acme-core:data", description: "Query SQL and MongoDB" },
	{ name: "ship-status", description: "A/B test ship status from Mixpanel" },
];

describe("skillToken", () => {
	test("opens on a slash token at the end", () => {
		expect(skillToken("/")).toBe("");
		expect(skillToken("/gd")).toBe("gd");
		expect(skillToken("check the /acme-core:da")).toBe("acme-core:da");
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
			"acme-core:data",
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
	expect(insertSkill("audit tickets /acme", "acme-core:data")).toBe(
		"audit tickets /acme-core:data ",
	);
});

test("/compact is Claude's command, not a skill that mentions compacting", () => {
	const recall = {
		name: "recall",
		description: "Resume with a compact digest",
	};
	const [first] = matchSkills([...BUILT_IN_COMMANDS, recall], "compact");
	expect(first?.name).toBe("compact");
	expect(enterPicks("compact", "compact")).toBe(true);
	expect(enterPicks("recall", "compact")).toBe(false);
});

describe("taskSkillToken", () => {
	test("opens on a slash token heading the title", () => {
		expect(taskSkillToken("/")).toBe("");
		expect(taskSkillToken("/odin-")).toBe("odin-");
		expect(taskSkillToken("!!! /acme-core:da")).toBe("acme-core:da");
		expect(taskSkillToken("/gd\nthe brief")).toBe("gd");
	});

	test("stays closed once the title moves on, or for a slash mid-title", () => {
		expect(taskSkillToken("")).toBeUndefined();
		expect(taskSkillToken("/gdpr audit")).toBeUndefined();
		expect(taskSkillToken("check the /gd")).toBeUndefined();
		expect(taskSkillToken("title\n/gd")).toBeUndefined();
	});
});

describe("completeTaskSkill", () => {
	test("swaps the token for the skill and leaves room for the title", () => {
		expect(completeTaskSkill("/odin-", "odin-release-announcement")).toBe(
			"/odin-release-announcement ",
		);
		expect(completeTaskSkill("!! /gd\nthe brief", "gdpr")).toBe(
			"!! /gdpr \nthe brief",
		);
	});
});

test("/plan is offered as Claude's own command", () => {
	const [first] = matchSkills(BUILT_IN_COMMANDS, "plan");
	expect(first?.name).toBe("plan");
});

test("each Claude command is listed once", () => {
	const names = BUILT_IN_COMMANDS.map((command) => command.name);
	expect(new Set(names).size).toBe(names.length);
});
