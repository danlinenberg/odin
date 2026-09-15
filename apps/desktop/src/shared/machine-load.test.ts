import { describe, expect, it } from "bun:test";
import { type MachineLoadInput, machineLoad } from "./machine-load";

const GB = 1024 ** 3;

/** A 10-core, 32 GB Mac with `agents` sessions and `totalCpu` burned across them. */
function snapshot({
	load = 1,
	memory = 50,
	totalCpu = 0,
	totalMemory = 0,
	hostMemory = 32 * GB,
	available = 0,
	agents = 0,
}: {
	load?: number;
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
			loadAverage1m: load,
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
	it("is not busy when the agents are only idling", () => {
		// The real shape of a loaded-looking Mac: a dozen sessions parked on the
		// API, load average at the core count, memory "full" the way macOS
		// always reports it. None of that should hold a launch back.
		const load = machineLoad(
			snapshot({ load: 11, memory: 95, totalCpu: 100, agents: 12 }),
		);
		expect(load.busy).toBe(false);
		expect(load.agentCpuPercent).toBe(10);
		expect(load.cpuPercent).toBe(110);
	});

	it("is busy once the agents actually own the machine", () => {
		const load = machineLoad(snapshot({ totalCpu: 850, agents: 6 }));
		expect(load.busy).toBe(true);
		expect(load.reason).toBe("6 agents using 85% of this Mac");
	});

	it("says agent, singular, for one", () => {
		expect(machineLoad(snapshot({ totalCpu: 900, agents: 1 })).reason).toBe(
			"1 agent using 90% of this Mac",
		);
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
					loadAverage1m: 0,
					memoryUsagePercent: 0,
					totalMemory: 0,
					availableMemory: 0,
				},
				totalCpu: 0,
				totalMemory: Number.NaN,
				workspaces: [],
			}),
		).toMatchObject({
			busy: false,
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
