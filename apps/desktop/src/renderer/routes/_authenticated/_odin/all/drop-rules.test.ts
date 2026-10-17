import { expect, test } from "bun:test";
import type { AllItem } from "./all-items";
import { matchesRule, rulesFor } from "./drop-rules";

const pr = (over: Partial<AllItem>) =>
	({
		key: "pr:1",
		source: "GitHub",
		title: "fix(deps): update weekly-dependency-updates",
		person: "renovate[bot]",
		context: "imagenai/app-web-server",
		...over,
	}) as AllItem;

test("a row offers one rule per field it has, and they match its kind only", () => {
	const rules = rulesFor(pr({ context: null }));
	expect(rules.map((r) => r.field)).toEqual(["person", "title"]);
	const [byPerson] = rules;
	if (!byPerson) throw new Error("no rule");
	expect(matchesRule(pr({ key: "pr:2", title: "other" }), byPerson)).toBe(true);
	expect(matchesRule(pr({ person: "dan" }), byPerson)).toBe(false);
	expect(matchesRule(pr({ source: "Slack" }), byPerson)).toBe(false);
});
