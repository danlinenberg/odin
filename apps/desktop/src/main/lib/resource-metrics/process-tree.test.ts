import { describe, expect, it } from "bun:test";
import type os from "node:os";
import {
	getSubtreePids,
	getSubtreeResources,
	type ProcessInfo,
	type ProcessSnapshot,
	readCpuUsagePercent,
} from "./process-tree";

function buildSnapshot(processes: ProcessInfo[]): ProcessSnapshot {
	const byPid = new Map<number, ProcessInfo>();
	const childrenOf = new Map<number, number[]>();

	for (const p of processes) {
		byPid.set(p.pid, p);
		let children = childrenOf.get(p.ppid);
		if (!children) {
			children = [];
			childrenOf.set(p.ppid, children);
		}
		children.push(p.pid);
	}

	return { byPid, childrenOf };
}

describe("getSubtreePids", () => {
	it("returns the root PID when it has no children", () => {
		const snapshot = buildSnapshot([
			{ pid: 100, ppid: 1, cpu: 5, memory: 1024 },
		]);
		expect(getSubtreePids(snapshot, 100)).toEqual([100]);
	});

	it("returns all descendants including the root", () => {
		const snapshot = buildSnapshot([
			{ pid: 100, ppid: 1, cpu: 1, memory: 100 },
			{ pid: 200, ppid: 100, cpu: 2, memory: 200 },
			{ pid: 300, ppid: 100, cpu: 3, memory: 300 },
			{ pid: 400, ppid: 200, cpu: 4, memory: 400 },
		]);

		const pids = getSubtreePids(snapshot, 100).sort();
		expect(pids).toEqual([100, 200, 300, 400]);
	});

	it("returns empty array when root PID is not in snapshot", () => {
		const snapshot = buildSnapshot([
			{ pid: 100, ppid: 1, cpu: 1, memory: 100 },
		]);
		expect(getSubtreePids(snapshot, 999)).toEqual([]);
	});

	it("handles deeply nested trees", () => {
		const snapshot = buildSnapshot([
			{ pid: 1, ppid: 0, cpu: 1, memory: 100 },
			{ pid: 2, ppid: 1, cpu: 1, memory: 100 },
			{ pid: 3, ppid: 2, cpu: 1, memory: 100 },
			{ pid: 4, ppid: 3, cpu: 1, memory: 100 },
			{ pid: 5, ppid: 4, cpu: 1, memory: 100 },
		]);

		const pids = getSubtreePids(snapshot, 1).sort();
		expect(pids).toEqual([1, 2, 3, 4, 5]);
	});

	it("does not include sibling subtrees", () => {
		const snapshot = buildSnapshot([
			{ pid: 1, ppid: 0, cpu: 1, memory: 100 },
			{ pid: 10, ppid: 1, cpu: 1, memory: 100 },
			{ pid: 20, ppid: 1, cpu: 1, memory: 100 },
			{ pid: 11, ppid: 10, cpu: 1, memory: 100 },
			{ pid: 21, ppid: 20, cpu: 1, memory: 100 },
		]);

		const pids = getSubtreePids(snapshot, 10).sort();
		expect(pids).toEqual([10, 11]);
	});
});

describe("getSubtreeResources", () => {
	it("sums CPU and memory across the subtree", () => {
		const snapshot = buildSnapshot([
			{ pid: 100, ppid: 1, cpu: 10, memory: 1000 },
			{ pid: 200, ppid: 100, cpu: 20, memory: 2000 },
			{ pid: 300, ppid: 100, cpu: 30, memory: 3000 },
			{ pid: 400, ppid: 200, cpu: 40, memory: 4000 },
		]);

		const resources = getSubtreeResources(snapshot, 100);
		expect(resources.cpu).toBe(100);
		expect(resources.memory).toBe(10000);
		expect(resources.pids.sort()).toEqual([100, 200, 300, 400]);
	});

	it("returns zero for a nonexistent root PID", () => {
		const snapshot = buildSnapshot([
			{ pid: 100, ppid: 1, cpu: 50, memory: 5000 },
		]);

		const resources = getSubtreeResources(snapshot, 999);
		expect(resources.cpu).toBe(0);
		expect(resources.memory).toBe(0);
		expect(resources.pids).toEqual([]);
	});

	it("returns only the root's resources when it has no children", () => {
		const snapshot = buildSnapshot([
			{ pid: 42, ppid: 1, cpu: 15.5, memory: 2048 },
		]);

		const resources = getSubtreeResources(snapshot, 42);
		expect(resources.cpu).toBe(15.5);
		expect(resources.memory).toBe(2048);
		expect(resources.pids).toEqual([42]);
	});
});

describe("readCpuUsagePercent", () => {
	/** `count` cores that have spent `idle`/`busy` ms in each state. */
	function cpus(idle: number, busy: number, count = 4): os.CpuInfo[] {
		return Array.from({ length: count }, () => ({
			model: "test",
			speed: 0,
			times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
		}));
	}

	it("reads the busy share of the interval between two samples", () => {
		// First sample only primes the baseline — cumulative counters have
		// nothing to subtract yet.
		expect(readCpuUsagePercent(cpus(1000, 1000))).toBe(0);
		// Next interval: 20 ms idle, 980 ms busy per core. That's the Mac in
		// the bug report, not the 1-minute load average's opinion of it.
		expect(Math.round(readCpuUsagePercent(cpus(1020, 1980)))).toBe(98);
	});

	it("keeps the last reading when two samples land microseconds apart", () => {
		// A snapshot builds host metrics twice; the second sample has no
		// meaningful interval, and 0/0 would flash the gate open.
		expect(Math.round(readCpuUsagePercent(cpus(1021, 1981)))).toBe(98);
	});
});
