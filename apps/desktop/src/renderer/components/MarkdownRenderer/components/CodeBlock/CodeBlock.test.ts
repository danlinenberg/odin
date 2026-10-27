import { expect, test } from "bun:test";
import {
	isRtlText,
	looksLikeProse,
	markRtlLines,
	toSlackTexty,
} from "./CodeBlock";

test("a drafted message is prose, commands and trees are not", () => {
	expect(
		looksLikeProse(
			"@Yoav it's not a quota issue, AWS just doesn't have g6.2xlarge left in our AZs.\n\nAny objections?",
		),
	).toBe(true);
	expect(looksLikeProse("bun run compile:app\ngit status")).toBe(false);
	expect(looksLikeProse("src/\n  index.ts\n  lib/")).toBe(false);
	// A draft whose lines skip the final period is still a draft.
	expect(
		looksLikeProse(
			"Hey, went over the Studio Usage tab - 3 things look off:\n\n2. Culling line dropping 149 → 40 users - the culling projects part of the query filters `software_version = '27.0.1'`. Week of Oct 18 that's 70 of 1,313 culling projects for flag users, the rest are on newer 27.x",
		),
	).toBe(true);
	expect(
		looksLikeProse(
			"curl -sf http://127.0.0.1:$ODIN_PORT/odin --data-urlencode action=worktree --data-urlencode repo=/Users/dan/dev/private/odin --data-urlencode name=fix -o out.json -w %{http_code}",
		),
	).toBe(false);
	// A long English comment doesn't make code a draft.
	expect(
		looksLikeProse(
			"key = os.environ['KEY']\n# Handle a key that may be stored on a single line in the secrets manager format\nif not key:\n    raise ValueError(key)",
		),
	).toBe(false);
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

test("a ``` fence copies as a Slack code block", () => {
	expect(
		JSON.parse(toSlackTexty("1. add:\n```\n[sso]\nregion = *x*\n```\n2. done")),
	).toEqual({
		ops: [
			{ insert: "1. add:\n" },
			{ insert: "[sso]" },
			{ insert: "\n", attributes: { "code-block": true } },
			{ insert: "region = *x*" },
			{ insert: "\n", attributes: { "code-block": true } },
			{ insert: "2. done" },
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

test("a draft reads right-to-left when most of its letters are Hebrew, whatever comes first", () => {
	expect(
		isRtlText("btw כרגע בעמוד הbilling שלהם התשלום הבא מציג את כל החודשים"),
	).toBe(true);
	expect(isRtlText("<@U0C62025C31> יכול לבדוק שוב?")).toBe(true);
	expect(isRtlText("Can you check the invoice for Zappwise? CC שירה")).toBe(
		false,
	);
	expect(isRtlText("git status")).toBe(false);
});
