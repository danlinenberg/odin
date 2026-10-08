import { expect, test } from "bun:test";
import { looksLikeProse } from "./CodeBlock";

test("a drafted message is prose, commands and trees are not", () => {
	expect(
		looksLikeProse(
			"@Yoav it's not a quota issue, AWS just doesn't have g6.2xlarge left in our AZs.\n\nAny objections?",
		),
	).toBe(true);
	expect(looksLikeProse("bun run compile:app\ngit status")).toBe(false);
	expect(looksLikeProse("src/\n  index.ts\n  lib/")).toBe(false);
});
