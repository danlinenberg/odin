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

describe("judgeKept", () => {
	const fakeClaude = `${require("node:os").tmpdir()}/fake-claude-${process.pid}.sh`;
	require("node:fs").writeFileSync(
		fakeClaude,
		`#!/bin/sh\necho '{"drop":[{"n":1,"why":"Nati fixed it"}]}'\n`,
		{ mode: 0o755 },
	);

	test("reads once per stamp, and answers from what it knows", async () => {
		const { judgeKept } = await import("./sweep-judge");
		let reads = 0;
		const read = async () => {
			reads++;
			return "Ardon [QUEUED]: can you check?\nNati: fixed";
		};
		const row = { key: "slack:k1", source: "#rnd", ref: "C1:1.1", stamp: "1|" };
		const first = await judgeKept([row], read, { claudeBin: fakeClaude });
		expect([...first.drops]).toEqual([["slack:k1", "Nati fixed it"]]);
		const again = await judgeKept([row], read, { claudeBin: fakeClaude });
		expect(again.drops.size).toBe(1);
		expect(reads).toBe(1);
		await judgeKept([{ ...row, stamp: "2|" }], read, { claudeBin: fakeClaude });
		expect(reads).toBe(2);
	});

	test("a read that outlasts the budget is pending, not lost", async () => {
		const { judgeKept } = await import("./sweep-judge");
		const slow = () =>
			new Promise<string>((r) => setTimeout(() => r("x"), 300));
		const row = { key: "slack:k2", source: "#rnd", ref: "C1:2.2", stamp: "1|" };
		const out = await judgeKept([row], slow, {
			budgetMs: 10,
			claudeBin: fakeClaude,
		});
		expect(out.pending).toBe(1);
		await new Promise((r) => setTimeout(r, 600));
		const later = await judgeKept([row], slow, {
			budgetMs: 10,
			claudeBin: fakeClaude,
		});
		expect(later.pending).toBe(0);
	});
});
