import { describe, expect, it } from "bun:test";
import { launchBlocker, sessionInFlight } from "./launch-gate";
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

	it("holds a second agent out of any repo's checkout", () => {
		const held = [
			pane({ id: "a", status: "working", odinCwd: "/tmp/repo", name: "x" }),
		];
		expect(launchBlocker(snapshot(10), held, "/tmp/repo", ODIN)).toBe(
			'waiting for "x" to finish in the repo checkout',
		);
		expect(launchBlocker(snapshot(10), held, "/tmp/other", ODIN)).toBeNull();
	});

	it("lets a queued Odin task through once the one ahead finishes", () => {
		const done = [
			pane({ id: "a", status: "review", initialCwd: ODIN, name: "x" }),
		];
		expect(launchBlocker(snapshot(10), done, ODIN, ODIN)).toBeNull();
	});
});

describe("sessionInFlight", () => {
	const REPO = "/Users/dan/dev/imagen";
	const working = (over: Partial<Pane>): Pane =>
		pane({
			id: "p1",
			name: "session",
			status: "working",
			initialCwd: REPO,
			...over,
		});

	it("finds the agent currently working in the checkout", () => {
		expect(
			sessionInFlight([working({ odinTaskTitle: "Fix it" })], REPO, ODIN),
		).toEqual({ paneId: "p1", title: "Fix it" });
	});

	// Stopped to ask permission is still mid-run: it owns the tree.
	it("counts a session parked on a permission prompt", () => {
		expect(
			sessionInFlight([working({ status: "permission" })], REPO, ODIN),
		).not.toBeNull();
	});

	it("ignores sessions that have stopped", () => {
		for (const over of [
			{ status: "review" },
			{ status: "idle" },
			{ status: "failed" },
			{ completed: true },
		] as Partial<Pane>[])
			expect(sessionInFlight([working(over)], REPO, ODIN)).toBeNull();
	});

	it("counts nested paths, and nothing merely sharing a prefix", () => {
		const held = [working({})];
		expect(sessionInFlight(held, `${REPO}/.worktrees/x`, ODIN)).not.toBeNull();
		expect(sessionInFlight(held, `${REPO}-old`, ODIN)).toBeNull();
		expect(
			sessionInFlight([working({ initialCwd: `${REPO}/apps/x` })], REPO, ODIN),
		).not.toBeNull();
	});

	// Opening a session's terminal clears initialCwd; odinCwd survives it.
	it("goes by where the session was launched, not where it wandered", () => {
		expect(
			sessionInFlight(
				[working({ initialCwd: undefined, odinCwd: REPO, cwd: "/tmp" })],
				REPO,
				ODIN,
			),
		).not.toBeNull();
		expect(
			sessionInFlight([working({ initialCwd: REPO, cwd: "/tmp" })], REPO, ODIN),
		).not.toBeNull();
	});

	// Sessions from before odinCwd: the #odin tag stamped at launch is left.
	it("counts an #odin session whose cwd has been forgotten", () => {
		const held = [working({ initialCwd: undefined, odinTags: ["odin"] })];
		expect(sessionInFlight(held, ODIN, ODIN)).not.toBeNull();
		expect(sessionInFlight(held, REPO, ODIN)).toBeNull();
		expect(sessionInFlight(held, ODIN, null)).toBeNull();
	});

	it("blocks nothing without a cwd to compare", () => {
		expect(
			sessionInFlight([working({ initialCwd: undefined })], REPO, ODIN),
		).toBeNull();
		expect(sessionInFlight([working({})], "", ODIN)).toBeNull();
	});
});
