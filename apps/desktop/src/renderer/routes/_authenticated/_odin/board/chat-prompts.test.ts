import { describe, expect, test } from "bun:test";
import { answerKeys, chatAboutKeys } from "./ChatPrompts";
import { collectRefs, linkify } from "./chat-links";

describe("chatAboutKeys - Claude Code's question menu", () => {
	test("Chat about this sits two past the last option, after Type something", () => {
		expect(chatAboutKeys([{ options: [{}, {}] }])).toEqual(["4"]);
		expect(chatAboutKeys([{ options: [{}, {}, {}] }])).toEqual(["5"]);
	});

	test("with previews it has no number: arrow down past the options, Enter", () => {
		const down = "\x1b[B";
		expect(chatAboutKeys([{ options: [{ preview: "a" }, {}] }])).toEqual([
			down,
			down,
			"\r",
		]);
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

describe("answerKeys - options with previews", () => {
	const tag = { options: [{ preview: "a" }, { preview: "b" }, {}] };

	test("a number only moves the cursor there, so Enter picks", () => {
		expect(answerKeys([tag], [[2]])).toEqual(["3", "\r"]);
	});

	test("then the next question, as replayed on Claude Code 2.1.294", () => {
		expect(answerKeys([tag, { multiSelect: true }], [[1], [0, 2]])).toEqual([
			"2",
			"\r",
			"1",
			"3",
			"\t",
			"\r",
		]);
	});
});

describe("answerKeys - a typed answer", () => {
	const color = { options: [{}, {}] };
	const pets = { multiSelect: true, options: [{}, {}, {}] };
	const down = "\x1b[B";

	test("a lone single-choice question: Type something, the text, Enter", () => {
		expect(answerKeys([color], [[]], ["Green"])).toEqual(["3", "Green", "\r"]);
	});

	test("multi-select: picks, arrow to Type something, the text, Tab, Enter", () => {
		expect(answerKeys([pets], [[0]], ["Bird"])).toEqual([
			"1",
			down,
			down,
			down,
			"Bird",
			"\t",
			"\r",
			"\r",
		]);
	});

	test("mixed form, as replayed on Claude Code 2.1.294", () => {
		expect(
			answerKeys([pets, color], [[0], []], ["A bird", "Dark green"]),
		).toEqual([
			"1",
			down,
			down,
			down,
			"A bird",
			"\t",
			"\r",
			"3",
			"Dark green",
			"\r",
			"\r",
		]);
	});

	test("the text is one line; blank text falls back to the picks", () => {
		expect(answerKeys([color], [[]], ["  two\nlines "])).toEqual([
			"3",
			"two lines",
			"\r",
		]);
		expect(answerKeys([color], [[1]], ["   "])).toEqual(["2"]);
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
