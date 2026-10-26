import { expect, test } from "bun:test";
import { looksLikeProse, markRtlLines, toSlackTexty } from "./CodeBlock";

test("a drafted message is prose, commands and trees are not", () => {
	expect(
		looksLikeProse(
			"@Yoav it's not a quota issue, AWS just doesn't have g6.2xlarge left in our AZs.\n\nAny objections?",
		),
	).toBe(true);
	expect(looksLikeProse("bun run compile:app\ngit status")).toBe(false);
	expect(looksLikeProse("src/\n  index.ts\n  lib/")).toBe(false);
	// Hebrew drafts rarely end a line with a period.
	expect(
		looksLikeProse("לגבי האיטיות - נראה לי שהבעיה בhost\n1. תפתחי Settings"),
	).toBe(true);
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

test("a known name labels the mention", () => {
	const [mention] = JSON.parse(
		toSlackTexty("<@U0C62025C31> hi", { U0C62025C31: "Ayelet Holtzman Ravid" }),
	).ops;
	expect(mention.insert).toBe("@Ayelet Holtzman Ravid");
	expect(mention.attributes.slackmention.id).toBe("U0C62025C31");
});

test("a copied Hebrew line starts with a right-to-left mark, English lines don't", () => {
	expect(markRtlLines("שלום\n1. תפתחי Settings\nPlease review")).toBe(
		"\u200Fשלום\n\u200F1. תפתחי Settings\nPlease review",
	);
	expect(markRtlLines("\u200Fשלום")).toBe("\u200Fשלום");
});
