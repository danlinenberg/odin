import { describe, expect, it } from "bun:test";
import {
	boardIdentity,
	buildPrompt,
	parseDataUrl,
	waitForCapacity,
} from "./useLaunchTaskSession";

describe("boardIdentity", () => {
	const ledger = {
		title: "Hi good morning :sunny:",
		person: "Ron Oren",
		externalId: "C0BA028MF7W:1789357218.234749",
		source: "reactions",
	};

	it("gives a resumed session back the ask, the person and the feed item", () => {
		// What Session History knows: Claude's title for the transcript, nothing else.
		expect(
			boardIdentity({ title: "Ingest and execute Slack thread task" }, ledger),
		).toEqual({
			title: "Hi good morning :sunny:",
			contact: "Ron Oren",
			pageId: "C0BA028MF7W:1789357218.234749",
			source: "reactions",
			key: "C0BA028MF7W:1789357218.234749",
		});
	});

	it("leaves a fresh launch alone", () => {
		expect(
			boardIdentity({
				title: "BUGT-1: fix the thing",
				contact: "Orly",
				pageId: "BUGT-1",
				source: "jira",
				key: "BUGT-1",
			}),
		).toEqual({
			title: "BUGT-1: fix the thing",
			contact: "Orly",
			pageId: "BUGT-1",
			source: "jira",
			key: "BUGT-1",
		});
	});

	it("has nothing to restore for a session older than the ledger", () => {
		expect(boardIdentity({ title: "run the migration" })).toEqual({
			title: "run the migration",
			contact: null,
			pageId: null,
			source: undefined,
			key: undefined,
		});
	});
});

describe("buildPrompt", () => {
	it("cites attachments so the agent knows to read them", () => {
		const prompt = buildPrompt("Fix the board", "It wraps oddly", [
			"/repo/.odin/attachments/fix-1.png",
		]);
		expect(prompt).toContain("Task: Fix the board");
		expect(prompt).toContain("It wraps oddly");
		expect(prompt).toContain("/repo/.odin/attachments/fix-1.png");
	});

	it("tells the agent how to get at a video", () => {
		const prompt = buildPrompt("Watch this", null, ["/Users/dan/bug.mov"]);
		expect(prompt).toContain("/Users/dan/bug.mov");
		expect(prompt).toContain("ffmpeg");
	});

	it("keeps the ffmpeg hint out of image-only prompts", () => {
		expect(
			buildPrompt("Watch this", null, ["/repo/.odin/a.png"]),
		).not.toContain("ffmpeg");
	});

	it("says nothing about attachments when there are none", () => {
		expect(buildPrompt("Fix the board", null)).not.toContain("Attached");
	});
});

describe("parseDataUrl", () => {
	it("takes the extension from the mime type, not the filename", () => {
		expect(parseDataUrl("data:image/png;base64,AAA")).toEqual({
			base64: "AAA",
			extension: "png",
		});
		expect(parseDataUrl("data:image/jpeg;base64,BBB").extension).toBe("jpg");
		expect(parseDataUrl("data:image/svg+xml;base64,CCC").extension).toBe("svg");
		expect(parseDataUrl("data:video/quicktime;base64,DDD").extension).toBe(
			"mov",
		);
		expect(parseDataUrl("data:video/mp4;base64,EEE").extension).toBe("mp4");
	});

	it("falls back to png for a header it can't read", () => {
		expect(parseDataUrl("nonsense,FFF")).toEqual({
			base64: "FFF",
			extension: "png",
		});
	});
});

describe("waitForCapacity", () => {
	const BUSY = {
		cpuPercent: 95,
		agentCpuPercent: 90,
		agentMemoryGb: 12.4,
		memoryPercent: 60,
		agentCount: 6,
		roomForMore: 0,
		sessionMemoryGb: 2,
		busy: true,
		reason: "6 agents using 90% of CPU",
	};
	const FREE = { ...BUSY, busy: true, reason: null, cpuPercent: 10 };
	const IDLE = { ...FREE, busy: false };

	/** Collects the callbacks so a test can assert what the user was told. */
	function spy() {
		const waited: (string | null)[] = [];
		let proceeded = 0;
		return {
			waited,
			proceeded: () => proceeded,
			onWait: (load: { reason: string | null }) => waited.push(load.reason),
			onProceed: () => {
				proceeded += 1;
			},
		};
	}

	it("starts immediately on a quiet machine, saying nothing", async () => {
		const s = spy();
		await waitForCapacity({
			readLoad: async () => IDLE,
			onWait: s.onWait,
			onProceed: s.onProceed,
			skipped: () => false,
			pollMs: 1,
		});
		expect(s.waited).toEqual([]);
		expect(s.proceeded()).toBe(0);
	});

	it("holds while busy, warns once, and reports going ahead", async () => {
		const s = spy();
		let calls = 0;
		await waitForCapacity({
			readLoad: async () => (++calls < 3 ? BUSY : IDLE),
			onWait: s.onWait,
			onProceed: s.onProceed,
			skipped: () => false,
			pollMs: 1,
		});
		expect(calls).toBe(3);
		expect(s.waited).toEqual(["6 agents using 90% of CPU"]);
		expect(s.proceeded()).toBe(1);
	});

	it("gives up waiting once the deadline passes", async () => {
		const s = spy();
		await waitForCapacity({
			readLoad: async () => BUSY,
			onWait: s.onWait,
			onProceed: s.onProceed,
			skipped: () => false,
			pollMs: 1,
			maxWaitMs: 0,
		});
		expect(s.proceeded()).toBe(1);
	});

	it("lets a broken gauge through instead of blocking the launch", async () => {
		const s = spy();
		await waitForCapacity({
			readLoad: async () => {
				throw new Error("no metrics");
			},
			onWait: s.onWait,
			onProceed: s.onProceed,
			skipped: () => false,
			pollMs: 1,
		});
		expect(s.waited).toEqual([]);
	});

	it("stops waiting the moment the user says start now", async () => {
		const s = spy();
		let calls = 0;
		let startNow = false;
		await waitForCapacity({
			readLoad: async () => {
				calls += 1;
				startNow = true;
				return BUSY;
			},
			onWait: s.onWait,
			onProceed: s.onProceed,
			skipped: () => startNow,
			pollMs: 1,
		});
		expect(calls).toBe(1);
		expect(s.proceeded()).toBe(1);
	});
});
