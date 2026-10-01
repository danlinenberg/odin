import { describe, expect, test } from "bun:test";
import { parseJudgements } from "./sweep-judge";

describe("parseJudgements", () => {
	test("maps numbered drops back to keys, ignoring prose and unknown numbers", () => {
		const out = parseJudgements(
			'Here you go: {"drop": [{"n": 2, "why": "Nati answered it"}, {"n": 9, "why": "x"}]}',
			["slack:a", "slack:b"],
		);
		expect([...out]).toEqual([["slack:b", "Nati answered it"]]);
	});

	test("garbage is no drops, not a throw", () => {
		expect(parseJudgements("sorry, I can't", ["slack:a"]).size).toBe(0);
		expect(parseJudgements("{not json}", ["slack:a"]).size).toBe(0);
	});
});
