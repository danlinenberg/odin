import { expect, test } from "bun:test";
import { hasDoubleTap, withDoubleTap } from "./karabiner";

test("adds the rule after the selected profile's rules, once, and removes it", () => {
	const other = { name: "Other", selected: false };
	const selected = {
		name: "Default profile",
		selected: true,
		complex_modifications: {
			parameters: {},
			rules: [{ description: "Kid lock" }],
		},
	};
	const config = { profiles: [other, selected] };
	expect(hasDoubleTap(config)).toBe(false);

	withDoubleTap(config, "open 'A'");
	withDoubleTap(config, "open 'B'");
	const rules = selected.complex_modifications.rules;
	expect(rules.map((r) => r.description)).toEqual([
		"Kid lock",
		"Double-tap right command to open Odin",
	]);
	expect(JSON.stringify(rules[1])).toContain("open 'B'");
	expect(selected.complex_modifications.parameters).toEqual({});
	expect(other).toEqual({ name: "Other", selected: false });

	withDoubleTap(config, null);
	expect(hasDoubleTap(config)).toBe(false);
	expect(selected.complex_modifications.rules).toEqual([
		{ description: "Kid lock" },
	]);
});
