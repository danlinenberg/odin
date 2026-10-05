import { expect, test } from "bun:test";
import { doubleTapKey, withDoubleTap } from "./karabiner";

test("adds the rule after the selected profile's rules, once per key change, and removes it", () => {
	const other = { name: "Other", selected: false };
	const selected = {
		name: "Default profile",
		selected: true,
		complex_modifications: {
			parameters: {},
			rules: [{ description: "Kid lock" }] as {
				description?: string;
			}[],
		},
	};
	const config = { profiles: [other, selected] };
	expect(doubleTapKey(config)).toBe(null);

	withDoubleTap(config, "right_command", "open 'A'");
	withDoubleTap(config, "left_option", "open 'B'");
	const rules = selected.complex_modifications.rules;
	expect(rules.map((r) => r.description)).toEqual([
		"Kid lock",
		"Double-tap left option to open Odin",
	]);
	expect(doubleTapKey(config)).toBe("left_option");
	expect(JSON.stringify(rules[1])).toContain("open 'B'");
	expect(selected.complex_modifications.parameters).toEqual({});
	expect(other).toEqual({ name: "Other", selected: false });

	withDoubleTap(config, null, "open 'B'");
	expect(doubleTapKey(config)).toBe(null);
	expect(selected.complex_modifications.rules).toEqual([
		{ description: "Kid lock" },
	]);
});

test("reads the rule installed before the key was choosable", () => {
	const config = {
		profiles: [
			{
				selected: true,
				complex_modifications: {
					rules: [
						{
							description: "Double-tap right command to open Odin",
							manipulators: [{ from: { key_code: "right_command" } }],
						},
					],
				},
			},
		],
	};
	expect(doubleTapKey(config)).toBe("right_command");
});
