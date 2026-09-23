import { describe, expect, it } from "bun:test";
import { launchBlocker } from "./launch-gate";
import type { MachineLoadInput } from "./machine-load";
import type { Pane } from "./tabs-types";

const ODIN = "/Users/dan/dev/odin";

/** A snapshot with the whole machine at `hostCpu` percent and no agents. */
const snapshot = (hostCpu: number): MachineLoadInput => ({
	host: {
		cpuCoreCount: 12,
		cpuUsagePercent: hostCpu,
		memoryUsagePercent: 50,
		totalMemory: 64 * 1024 ** 3,
		availableMemory: 16 * 1024 ** 3,
	},
	totalCpu: 0,
	totalMemory: 0,
	workspaces: [],
});

const pane = (p: Partial<Pane>) => p as Pane;

describe("launchBlocker", () => {
	it("clears a launch on a quiet machine", () => {
		expect(launchBlocker(snapshot(10), [], "/tmp/repo", ODIN)).toBeNull();
	});

	it("holds a launch when the Mac is flat out", () => {
		expect(launchBlocker(snapshot(95), [], "/tmp/repo", ODIN)).toBe(
			"this Mac is at 95% CPU",
		);
	});

	it("holds a second agent out of Odin's own checkout", () => {
		const held = [
			pane({ id: "a", status: "working", initialCwd: ODIN, name: "x" }),
		];
		expect(launchBlocker(snapshot(10), held, ODIN, ODIN)).toBe(
			'waiting for "x" to finish in Odin\'s checkout',
		);
		// Another repo is unaffected — the gate is about the one checkout.
		expect(launchBlocker(snapshot(10), held, "/tmp/repo", ODIN)).toBeNull();
	});

	it("lets a queued Odin task through once the one ahead finishes", () => {
		const done = [
			pane({ id: "a", status: "review", initialCwd: ODIN, name: "x" }),
		];
		expect(launchBlocker(snapshot(10), done, ODIN, ODIN)).toBeNull();
	});
});
