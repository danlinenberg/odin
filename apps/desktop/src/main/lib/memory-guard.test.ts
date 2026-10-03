import { describe, expect, test } from "bun:test";
import { findOffenders, KILL_BYTES, WARN_BYTES } from "./memory-guard";

describe("findOffenders", () => {
	const snapshot = {
		byPid: new Map([
			[1, { pid: 1, ppid: 0, cpu: 0, memory: KILL_BYTES + 1 }],
			[2, { pid: 2, ppid: 1, cpu: 0, memory: KILL_BYTES + 1 }],
			[3, { pid: 3, ppid: 1, cpu: 0, memory: WARN_BYTES + 1 }],
			[4, { pid: 4, ppid: 1, cpu: 0, memory: WARN_BYTES - 1 }],
		]),
		childrenOf: new Map(),
	};

	test("warns past WARN, kills past KILL, never kills a spared root", () => {
		expect(findOffenders(snapshot, [1, 2, 3, 4], new Set([1]))).toEqual([
			{ pid: 1, memory: KILL_BYTES + 1, kill: false },
			{ pid: 2, memory: KILL_BYTES + 1, kill: true },
			{ pid: 3, memory: WARN_BYTES + 1, kill: false },
		]);
	});
});
