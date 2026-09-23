import { describe, expect, it } from "bun:test";
import {
	type MachineLoadInput,
	machineLoad,
	sessionUsageLabel,
} from "./machine-load";

const GB = 1024 ** 3;

/** A 10-core, 32 GB Mac with `agents` sessions and `totalCpu` burned across them. */
function snapshot({
	hostCpu = 0,
	memory = 50,
	totalCpu = 0,
	totalMemory = 0,
	hostMemory = 32 * GB,
	available = 0,
	agents = 0,
}: {
	hostCpu?: number;
	memory?: number;
	totalCpu?: number;
	totalMemory?: number;
	hostMemory?: number;
	available?: number;
	agents?: number;
}): MachineLoadInput {
	return {
		host: {
			cpuCoreCount: 10,
			cpuUsagePercent: hostCpu,
			memoryUsagePercent: memory,
			totalMemory: hostMemory,
			availableMemory: available,
		},
		totalCpu,
		totalMemory,
		workspaces: [{ sessions: Array.from({ length: agents }, () => ({})) }],
	};
}

describe("machineLoad", () => {
	it("reports the agents' share of the machine and the whole Mac's", () => {
		const load = machineLoad(
			snapshot({ hostCpu: 20, memory: 95, totalCpu: 100, agents: 12 }),
		);
		expect(load.agentCpuPercent).toBe(10);
		expect(load.cpuPercent).toBe(20);
	});

	it("reports the agents' own memory in GB", () => {
		// 3.5 GiB of RSS across the sessions — the number on the badge.
		expect(
			machineLoad(snapshot({ totalMemory: 3.5 * 1024 ** 3, agents: 2 }))
				.agentMemoryGb,
		).toBe(3.5);
	});

	it("survives a zero-core fallback snapshot", () => {
		expect(
			machineLoad({
				host: {
					cpuCoreCount: 0,
					memoryUsagePercent: 0,
					totalMemory: 0,
					availableMemory: 0,
				},
				totalCpu: 0,
				totalMemory: Number.NaN,
				workspaces: [],
			}),
		).toMatchObject({
			agentCpuPercent: 0,
			agentMemoryGb: 0,
			agentCount: 0,
			availableMemoryGb: 0,
		});
	});

	it("reports what the Mac still has free", () => {
		// The badge's second number, measured rather than forecast: 4.3 GB of
		// free-plus-reclaimable pages on a 24 GB Mac that is otherwise full.
		const load = machineLoad(
			snapshot({
				totalMemory: 3.4 * GB,
				hostMemory: 24 * GB,
				available: 4.3 * GB,
				agents: 9,
			}),
		);
		expect(load.availableMemoryGb).toBe(4.3);
		expect(load.agentMemoryGb).toBe(3.4);
		expect(load.agentCount).toBe(9);
	});
});

describe("sessionUsageLabel", () => {
	it("names a quiet session's memory without calling it heavy", () => {
		expect(sessionUsageLabel({ cpu: 4, memory: 0.4 * GB })).toEqual({
			label: "0.4 GB",
			heavy: false,
		});
	});

	it("marks a session holding a lot of memory as heavy", () => {
		expect(sessionUsageLabel({ cpu: 3, memory: 3.42 * GB })).toEqual({
			label: "3.4 GB",
			heavy: true,
		});
	});

	// A small session pinning a core is heavy too, and its memory alone would
	// never say so.
	it("adds the CPU when that's the part that's high", () => {
		expect(sessionUsageLabel({ cpu: 140, memory: 0.5 * GB })).toEqual({
			label: "0.5 GB · 140% CPU",
			heavy: true,
		});
	});
});
