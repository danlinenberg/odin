import { describe, expect, test } from "bun:test";
import {
	mentionIds,
	namedMessages,
	namedText,
	withNames,
} from "./mention-names";

const names = new Map([["U0123ABCD", "Riley"]]);
const lookup = async (id: string) => names.get(id) ?? null;

describe("mention names", () => {
	test("a raw mention, a labelled one and a bare id read as the name", () => {
		expect(
			withNames("<@U0123ABCD> hi <@U0123ABCD|riley> and @U0123ABCD", names),
		).toBe("@Riley hi @Riley and @Riley");
	});

	test("an id with no name reads @id, without the brackets", () => {
		expect(withNames("<@U0999ZZZZ> ok", names)).toBe("@U0999ZZZZ ok");
	});

	test("each id once", () => {
		expect(mentionIds("<@U0123ABCD> <@U0123ABCD> @W0456EFGHI")).toEqual([
			"U0123ABCD",
			"W0456EFGHI",
		]);
	});

	test("text with no mention is left as it is", async () => {
		const messages = [{ role: "user", text: "plain @here" }];
		expect(await namedMessages(messages, lookup)).toBe(messages);
	});

	test("a draft in a message gets the name", async () => {
		const [message] = await namedMessages(
			[{ text: "```text\n<@U0123ABCD> Deployed\n```" }],
			lookup,
		);
		expect(message.text).toBe("```text\n@Riley Deployed\n```");
	});

	test("a slow lookup doesn't hold the answer", async () => {
		const slow = () => new Promise<string | null>(() => {});
		expect(await namedText("<@U0123ABCD> hi", slow, 10)).toBe("@U0123ABCD hi");
	});
});
