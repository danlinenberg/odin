import { describe, expect, test } from "bun:test";
import { answerKeys, chatAboutKeys } from "./ChatPrompts";
import { collectRefs, linkify } from "./chat-links";

describe("chatAboutKeys - Claude Code's question menu", () => {
	test("Chat about this sits two past the last option, after Type something", () => {
		expect(chatAboutKeys([{ options: [{}, {}] }])).toEqual(["4"]);
		expect(chatAboutKeys([{ options: [{}, {}, {}] }])).toEqual(["5"]);
	});
});

describe("answerKeys - Claude Code's question menu", () => {
	test("a lone single-choice question answers on its number", () => {
		expect(answerKeys([{}], [[1]])).toEqual(["2"]);
	});

	test("multi-select toggles each pick, Tab moves on, Enter submits", () => {
		expect(answerKeys([{}, { multiSelect: true }], [[1], [0, 2]])).toEqual([
			"2",
			"1",
			"3",
			"\t",
			"\r",
		]);
		expect(answerKeys([{ multiSelect: true }], [[0]])).toEqual([
			"1",
			"\t",
			"\r",
		]);
	});
});

describe("chat links", () => {
	const refs = collectRefs([
		"opened https://github.com/danlinenberg/odin/pull/676 and https://imagenai.atlassian.net/browse/CRR-851",
	]);

	test("links refs the session has URLs for", () => {
		expect(linkify("Merge PR #676 then CRR-851.", refs)).toBe(
			"Merge [PR #676](https://github.com/danlinenberg/odin/pull/676) then [CRR-851](https://imagenai.atlassian.net/browse/CRR-851).",
		);
	});

	test("leaves unknown refs, code and existing links alone", () => {
		expect(linkify("#12 and `#676` and [x](https://a.b/#676)", refs)).toBe(
			"#12 and `#676` and [x](https://a.b/#676)",
		);
	});
});
