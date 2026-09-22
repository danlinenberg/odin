import { describe, expect, it } from "bun:test";
import {
	boardIdentity,
	buildPrompt,
	parseDataUrl,
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

	// A card in Needs you is only useful if the last turn says what I do about it.
	it("asks every session to end with action items for the reviewer", () => {
		expect(buildPrompt("Fix the board", null)).toContain("ACTION ITEMS");
	});

	// A 4am cron run that stops to ask a question waits until morning for an
	// answer it could have defaulted.
	it("tells a scheduled run that nobody is watching it", () => {
		const prompt = buildPrompt("Sweep the backlog", null, [], undefined, true);
		expect(prompt).toContain("started by a schedule");
		expect(buildPrompt("Sweep the backlog", null)).not.toContain(
			"started by a schedule",
		);
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

describe("buildPrompt with a skill", () => {
	it("leads with the invocation, the title as its argument", () => {
		const prompt = buildPrompt("Sweep the PR queue", "Only mine", [], "gdpr");
		expect(prompt.split("\n")[0]).toBe("/gdpr Sweep the PR queue");
		expect(prompt).toContain("Only mine");
		// The board still wants its closing section.
		expect(prompt).toContain("ACTION ITEMS");
	});

	it("without one it is the plain task prompt", () => {
		expect(buildPrompt("Sweep the PR queue", null).split("\n")[0]).toBe(
			"Task: Sweep the PR queue",
		);
	});
});
