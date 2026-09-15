import { describe, expect, it } from "bun:test";
import { type MachineLoadInput, machineLoad } from "./machine-load";

/** A 10-core Mac with `agents` sessions and `totalCpu` burned across them. */
function snapshot({
	load = 1,
	memory = 50,
	totalCpu = 0,
	totalMemory = 0,
	hostMemory = 32 * 1024 ** 3,
	agents = 0,
}: {
	load?: number;
	memory?: number;
	totalCpu?: number;
	totalMemory?: number;
	hostMemory?: number;
	agents?: number;
}): MachineLoadInput {
	return {
		host: {
			cpuCoreCount: 10,
			loadAverage1m: load,
			memoryUsagePercent: memory,
			totalMemory: hostMemory,
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
					totalMemory: Number.NaN,
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
			roomForMore: 0,
		});
	});
});

describe("memory budget", () => {
	const GB = 1024 ** 3;

	it("divides the spare budget by the nominal session size", () => {
		// 32 GB Mac, 70% budget = 22.4 GB. Sessions holding 8 GB leave 14.4 GB,
		// so seven more 2 GB sessions fit.
		const load = machineLoad(
			snapshot({ totalMemory: 8 * GB, hostMemory: 32 * GB, agents: 4 }),
		);
		expect(load.agentMemoryGb).toBe(8);
		expect(load.roomForMore).toBe(7);
	});

	it("counts the whole budget when nothing is running yet", () => {
		expect(machineLoad(snapshot({ hostMemory: 32 * GB })).roomForMore).toBe(11);
	});

	it("does not swing on how idle the running sessions are", () => {
		// The bug: dividing by the measured average let one parked session
		// holding 0.4 GB claim room for 40. Same memory, same answer, whether
		// it's one parked session or six.
		const parked = machineLoad(
			snapshot({ totalMemory: 0.4 * GB, hostMemory: 32 * GB, agents: 1 }),
		);
		const many = machineLoad(
			snapshot({ totalMemory: 0.4 * GB, hostMemory: 32 * GB, agents: 6 }),
		);
		expect(parked.roomForMore).toBe(11);
		expect(many.roomForMore).toBe(11);
	});

	it("reports no room once the agents are over budget", () => {
		const load = machineLoad(
			snapshot({ totalMemory: 30 * GB, hostMemory: 32 * GB, agents: 10 }),
		);
		expect(load.roomForMore).toBe(0);
	});
});
