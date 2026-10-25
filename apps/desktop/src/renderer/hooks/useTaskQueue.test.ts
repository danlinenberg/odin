import { describe, expect, test } from "bun:test";
import type { Pane } from "renderer/stores/tabs/types";
import { launchBlocker } from "shared/launch-gate";
import {
	DEFAULT_LAUNCH_LIMITS,
	type MachineLoadInput,
} from "shared/machine-load";
import {
	hostReadSinceStart,
	livePanes,
	MAC_START_GAP_MS,
	macPaceBlocker,
	markStarted,
	QUEUE_POLL,
	startQueuedPane,
} from "./useTaskQueue";

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

describe("start pacing", () => {
	test("a burst on the Mac starts one, then waits for it to show up", () => {
		const t = 1_000_000;
		expect(macPaceBlocker(t)).toBeNull();
		expect(macPaceBlocker(t + 300)).not.toBeNull();
		expect(macPaceBlocker(t + MAC_START_GAP_MS)).toBeNull();
	});

	test("a host start waits for a reading taken after the last one", () => {
		markStarted("host", 5_000);
		expect(hostReadSinceStart(4_000)).toBe(false);
		expect(hostReadSinceStart(6_000)).toBe(true);
		// No reading to be had lets it through, as a failed read does.
		expect(hostReadSinceStart(null)).toBe(true);
	});
});

describe("QUEUE_POLL", () => {
	test("keeps polling while Odin isn't the focused app", async () => {
		const { focusManager, QueryClient, QueryObserver } = await import(
			"@tanstack/react-query"
		);
		focusManager.setFocused(false);
		const client = new QueryClient();
		let fetches = 0;
		const observer = new QueryObserver(client, {
			queryKey: ["queue-poll"],
			queryFn: () => ++fetches,
			...QUEUE_POLL,
			refetchInterval: 10,
		});
		const stop = observer.subscribe(() => {});
		await new Promise((resolve) => setTimeout(resolve, 80));
		stop();
		client.clear();
		focusManager.setFocused(undefined);
		expect(fetches).toBeGreaterThan(2);
	});
});

describe("startQueuedPane", () => {
	test("Start now and the queue's tick start a pane once", async () => {
		const { useTabsStore } = await import("renderer/stores/tabs/store");
		const queued = pane("q", {
			odinQueued: { command: "claude --session-id s", reason: "busy" },
		});
		useTabsStore.setState({
			tabs: [{ id: "t", workspaceId: "w" }] as never,
			panes: { q: queued },
		});
		const calls: string[] = [];
		const client = {
			terminal: {
				kill: {
					mutate: async () => {
						calls.push("kill");
					},
				},
				createOrAttach: {
					mutate: async () => {
						await new Promise((resolve) => setTimeout(resolve, 10));
						calls.push("spawn");
					},
				},
			},
		} as never;
		await Promise.all([
			startQueuedPane(client, queued),
			startQueuedPane(client, queued),
		]);
		// Started already: a later tick holding the old pane leaves it alone.
		await startQueuedPane(client, queued);
		expect(calls).toEqual(["kill", "spawn"]);
		expect(useTabsStore.getState().panes.q?.odinQueued).toBeUndefined();
	});
});
