import { describe, expect, test } from "bun:test";
import { parseVerdicts } from "./parse";

/**
 * The parser is the trust boundary: a language model wrote this file, and what
 * comes out of it is a list of things to delete. Shape is forgiven, content
 * never is.
 */
describe("parseVerdicts", () => {
	test("reads a plain array", () => {
		expect(
			parseVerdicts('[{"n":1,"verdict":"DROP","evidence":"PR merged"}]'),
		).toEqual([{ n: 1, verdict: "DROP", evidence: "PR merged" }]);
	});

	test.each([
		["fenced", '```json\n[{"n":2,"verdict":"KEEP","evidence":"open"}]\n```'],
		["wrapped", '{"verdicts":[{"n":2,"verdict":"KEEP","evidence":"open"}]}'],
		["lowercase verdict", '[{"n":2,"verdict":"keep","evidence":"open"}]'],
		["numeric string", '[{"n":"2","verdict":"KEEP","evidence":"open"}]'],
	])("forgives %s", (_name, raw) => {
		expect(parseVerdicts(raw)).toEqual([
			{ n: 2, verdict: "KEEP", evidence: "open" },
		]);
	});

	test.each([
		["not JSON", "I checked them all and honestly most can go"],
		["a fourth verdict", '[{"n":1,"verdict":"MAYBE","evidence":"eh"}]'],
		["no number", '[{"verdict":"DROP","evidence":"done"}]'],
		["a zero number", '[{"n":0,"verdict":"DROP","evidence":"done"}]'],
		["a non-object row", '["DROP"]'],
	])("drops %s", (_name, raw) => {
		expect(parseVerdicts(raw)).toEqual([]);
	});

	test("keeps the first answer when an item is judged twice", () => {
		expect(
			parseVerdicts(
				'[{"n":1,"verdict":"DROP","evidence":"merged"},{"n":1,"verdict":"KEEP","evidence":"actually no"}]',
			),
		).toEqual([{ n: 1, verdict: "DROP", evidence: "merged" }]);
	});

	test("keeps the good rows out of a file with bad ones", () => {
		expect(
			parseVerdicts(
				'[{"n":1,"verdict":"NOPE","evidence":"x"},{"n":2,"verdict":"DROP","evidence":"closed"}]',
			),
		).toEqual([{ n: 2, verdict: "DROP", evidence: "closed" }]);
	});

	test("sorts by item number", () => {
		const rows = parseVerdicts(
			'[{"n":3,"verdict":"KEEP"},{"n":1,"verdict":"DROP"}]',
		);
		expect(rows.map((r) => r.n)).toEqual([1, 3]);
	});

	test("survives a missing evidence field rather than losing the row", () => {
		expect(parseVerdicts('[{"n":1,"verdict":"UNKNOWN"}]')).toEqual([
			{ n: 1, verdict: "UNKNOWN", evidence: "" },
		]);
	});
});
