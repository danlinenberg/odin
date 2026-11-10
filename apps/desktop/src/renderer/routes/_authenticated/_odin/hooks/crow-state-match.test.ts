import { expect, test } from "bun:test";
import { matching } from "./crow-state";

test("q keeps only the list items that mention it, case-insensitive", () => {
	const data = {
		rules: [
			{ id: "1", when: "touching Terraform", action: "plan first" },
			{ id: "2", when: "opening a PR", action: "run review" },
		],
		paused: false,
	};
	expect(matching(data, "terraform")).toEqual({
		rules: [data.rules[0]],
		paused: false,
	});
});
