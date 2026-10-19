import { expect, test } from "bun:test";
import { boardWords } from "./speech";

test("the board's names and unusual words are hints; plain English is not", () => {
	expect(
		boardWords(
			[
				"Fix the GraphQL limit on EC2s",
				"PAY-212 export stuck",
				"Reply to Maya's question about iOS",
			],
			["api", "Yuval", ""],
		),
	).toEqual(["api", "Yuval", "GraphQL", "EC2s", "PAY-212", "Maya", "iOS"]);
});
