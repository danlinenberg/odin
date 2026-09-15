import { describe, expect, it } from "bun:test";
import {
	AGENT_MEMORY_BUDGET_PERCENT,
	type MachineLoadInput,
	machineLoad,
} from "./machine-load";

const GB = 1024 ** 3;

/** A 10-core, 32 GB Mac with `agents` sessions and `totalCpu` burned across them. */
function snapshot({
	load = 1,
	memory = 50,
	totalCpu = 0,
	totalMemory = 0,
	appMemory = 0,
	hostMemory = 32 * GB,
	available = 0,
	agents = 0,
}: {
	load?: number;
	memory?: number;
	totalCpu?: number;
	totalMemory?: number;
	appMemory?: number;
	hostMemory?: number;
	available?: number;
	agents?: number;
}): MachineLoadInput {
	return {
		app: { memory: appMemory },
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
				app: { memory: 0 },
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
			roomForMore: 0,
		});
	});

	it("divides the memory budget by what a session actually costs", () => {
		// 32 GB Mac, 60% budget = 19.2 GB for sessions. 4 sessions holding 8 GB
		// between them (10 total minus 2 for the app) cost 2 GB each, so
		// (19.2 - 8) / 2 = 5 more fit.
		const load = machineLoad(
			snapshot({ totalMemory: 10 * GB, appMemory: 2 * GB, agents: 4 }),
		);
		expect(load.sessionMemoryGb).toBe(2);
		expect(load.roomForMore).toBe(5);
		expect(AGENT_MEMORY_BUDGET_PERCENT).toBe(60);
	});

	it("never costs a session below the floor", () => {
		// The screenshot bug: one pane measured seconds after launch holds
		// 0.36 GB, which divided a 14.4 GB budget into "room for 39" on a 24 GB
		// Mac. It gets costed at the 1.5 GB it will grow into instead.
		const load = machineLoad(
			snapshot({
				totalMemory: 3 * GB,
				appMemory: 2.64 * GB,
				hostMemory: 24 * GB,
				agents: 1,
			}),
		);
		expect(load.sessionMemoryGb).toBe(1.5);
		expect(load.roomForMore).toBe(9);
	});

	it("estimates a session cost before any sessions exist", () => {
		// Nothing to measure yet: 19.2 GB budget at the assumed 1.5 GB a session.
		expect(machineLoad(snapshot({})).roomForMore).toBe(12);
	});

	it("promises no more than the Mac can actually hand out", () => {
		// The screenshot bug, second half: a 24 GB Mac with 11 sessions has
		// 11.6 GB left *of the budget*, but Arc, Lightroom and a 10 GB
		// compressor left only 4.5 GB free. Three more fit, not seven.
		const load = machineLoad(
			snapshot({
				totalMemory: 4.3 * GB,
				appMemory: 1.5 * GB,
				hostMemory: 24 * GB,
				available: 4.5 * GB,
				agents: 11,
			}),
		);
		expect(load.roomForMore).toBe(3);
	});

	it("falls back to the budget when the snapshot can't say what's free", () => {
		// An app that hasn't restarted since this shipped sends no
		// `availableMemory`; reading that as "nothing free" would park the
		// badge on zero.
		expect(machineLoad(snapshot({ hostMemory: 24 * GB })).roomForMore).toBe(9);
	});

	it("reports no room once the budget is spent", () => {
		expect(
			machineLoad({
				...snapshot({ totalMemory: 20 * GB, agents: 10 }),
			}).roomForMore,
		).toBe(0);
	});

	it("reports no room while the CPU gate is holding launches", () => {
		// Plenty of memory left, but a launch would sit in waitForCapacity —
		// saying "room for 9" there would be a lie.
		expect(
			machineLoad(snapshot({ totalCpu: 850, totalMemory: 2 * GB, agents: 6 }))
				.roomForMore,
		).toBe(0);
	});
});
