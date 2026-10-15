import { expect, test } from "bun:test";
import { looksLikeProse, toSlackTexty } from "./CodeBlock";

test("a drafted message is prose, commands and trees are not", () => {
	expect(
		looksLikeProse(
			"@Yoav it's not a quota issue, AWS just doesn't have g6.2xlarge left in our AZs.\n\nAny objections?",
		),
	).toBe(true);
	expect(looksLikeProse("bun run compile:app\ngit status")).toBe(false);
	expect(looksLikeProse("src/\n  index.ts\n  lib/")).toBe(false);
});

test("a Slack mention copies as a real mention, markup as formatting", () => {
	expect(
		JSON.parse(toSlackTexty("<@U0C62025C31> you're *right*, see `x`")),
	).toEqual({
		ops: [
			{
				insert: "@U0C62025C31",
				attributes: {
					slackmention: {
						id: "U0C62025C31",
						label: "@U0C62025C31",
						mention: false,
						unverified: false,
					},
				},
			},
			{ insert: " you're " },
			{ insert: "right", attributes: { bold: true } },
			{ insert: ", see " },
			{ insert: "x", attributes: { code: true } },
			{ insert: "\n" },
		],
	});
});
