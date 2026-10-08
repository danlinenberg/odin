import { describe, expect, test } from "bun:test";
import type { Pane } from "renderer/stores/tabs/types";
import { launchBlocker } from "shared/launch-gate";
import {
	DEFAULT_LAUNCH_LIMITS,
	type MachineLoadInput,
} from "shared/machine-load";
import { livePanes } from "./useTaskQueue";

const odin = "/Users/me/odin";
const pane = (id: string, extra: Partial<Pane> = {}) =>
	({ id, tabId: "t", type: "terminal", name: id, ...extra }) as Pane;

describe("livePanes", () => {
	test("a card left 'working' by a restart no longer holds the queue", () => {
		const panes = {
			ghost: pane("ghost", { status: "working", odinCwd: odin }),
			queued: pane("queued", { odinCwd: odin }),
		};
		const idle: MachineLoadInput = {
			host: {
				cpuCoreCount: 12,
				cpuUsagePercent: 10,
				memoryUsagePercent: 50,
				totalMemory: 64 * 1024 ** 3,
				availableMemory: 16 * 1024 ** 3,
			},
			totalCpu: 0,
			totalMemory: 0,
			workspaces: [],
		};
		const limits = { ...DEFAULT_LAUNCH_LIMITS, maxWorkingAgents: 1 };
		expect(
			launchBlocker(idle, Object.values(panes), odin, odin, limits),
		).not.toBeNull();
		const live = livePanes(panes, [{ sessionId: "ghost", isAlive: false }]);
		expect(launchBlocker(idle, live, odin, odin, limits)).toBeNull();
	});
});
