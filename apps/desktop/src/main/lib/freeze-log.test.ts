import { describe, expect, it } from "bun:test";
import { type CpuProfile, describeStall } from "./freeze-log";

const frame = (functionName: string, url = "", lineNumber = 0) => ({
	functionName,
	url,
	lineNumber,
});

// Samples every 10ms from t=0: idle, then 30ms in scan, 10ms in parse, idle.
const profile: CpuProfile = {
	nodes: [
		{ id: 0, callFrame: frame("(root)"), children: [1, 4] },
		{ id: 1, callFrame: frame("(idle)") },
		{
			id: 4,
			callFrame: frame("tick", "file:///app/dist/main/index.js", 99),
			children: [2],
		},
		{
			id: 2,
			callFrame: frame("scan", "file:///app/dist/main/index.js", 41),
			children: [3],
		},
		{ id: 3, callFrame: frame("", "file:///app/dist/main/chunk.js", 9) },
	],
	startTime: 0,
	endTime: 70_000,
	samples: [1, 2, 2, 2, 3, 1, 1],
	timeDeltas: [0, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000],
};

describe("describeStall", () => {
	it("names the functions that ran in the stall, most time first", () => {
		expect(describeStall(profile, 10_000, 50_000)).toEqual([
			"30ms scan index.js:42 < tick index.js:100",
			"10ms anonymous chunk.js:10 < scan index.js:42 < tick index.js:100",
		]);
	});

	it("counts only the part of a sample inside the stall", () => {
		expect(describeStall(profile, 25_000, 35_000)).toEqual([
			"10ms scan index.js:42 < tick index.js:100",
		]);
	});

	it("says nothing for a stall outside the profile", () => {
		expect(describeStall(profile, 100_000, 200_000)).toEqual([]);
	});
});
