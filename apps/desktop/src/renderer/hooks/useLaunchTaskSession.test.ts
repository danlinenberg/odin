import { describe, expect, it } from "bun:test";
import {
	attachmentsOnDisk,
	boardIdentity,
	buildPrompt,
	parseDataUrl,
	WORKTREE_ASK_LINE,
} from "./useLaunchTaskSession";

describe("attachmentsOnDisk", () => {
	it("turns an editor's or the phone's image link, and a ~ path, into the file's absolute path", () => {
		expect(
			attachmentsOnDisk(
				"See ![](odin-attachment://file/1-a.png) and [b.pdf](odin-attachment://file/b.pdf)\n~/.odin/attachments/c.png",
				"/Users/dan",
			),
		).toBe(
			"See ![](/Users/dan/.odin/attachments/1-a.png) and [b.pdf](/Users/dan/.odin/attachments/b.pdf)\n/Users/dan/.odin/attachments/c.png",
		);
		expect(attachmentsOnDisk("plain text", "/Users/dan")).toBe("plain text");
	});
});

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

	it("asks for the exact commands when I have to run a write myself", () => {
		const prompt = buildPrompt("Fix the board", null);
		expect(prompt).toContain("exact copy-pasteable commands");
		// The `!` block is what gets a Run button (ChatView bangCommands).
		expect(prompt).toContain("first line starts with `!`");
	});

	// "Tell me when it ran, so I can read the result" - the Run button already
	// puts the command and its output into the session.
	it("reads a command's output itself instead of asking me to report it", () => {
		expect(buildPrompt("Fix the board", null)).toContain(
			"Never add an item asking me to tell you it ran",
		);
	});

	// "Choose how PR #1538 gets approved" kept coming back after a reviewer
	// had already approved it and the apply had started.
	it("re-checks an item's live state before listing it again", () => {
		expect(buildPrompt("Fix the board", null)).toContain(
			"check its live state now",
		);
	});

	// An item saying "run the command from my earlier message" left me
	// scrolling back for it; the Run button only shows in the same reply.
	it("repeats the command in every reply that asks me to run it", () => {
		expect(buildPrompt("Fix the board", null)).toContain(
			"again, even if an earlier reply already gave it",
		);
	});

	// Every `!` block is a Run button in the reply; a merge I could do from
	// the PR page came as one and sat in the way of reading the rest.
	it("hands me a `!` command only when I must run it and no page does it", () => {
		const prompt = buildPrompt("Fix the board", null);
		expect(prompt).toContain("only when I must run it myself");
		expect(prompt).toContain("to merge a PR, link the PR");
		expect(prompt).toContain("never goes in a `!` block");
	});

	// A `!` Run button on an UPDATE is one click from a prod write.
	it("gives a database write as a query, not a `!` command", () => {
		expect(buildPrompt("Fix the board", null)).toContain(
			"never give it as a `!` command",
		);
	});

	// "Run the worktree" went to a subagent nobody could watch.
	it("sends things to run into the session's Shell, not a subagent", () => {
		const prompt = buildPrompt("Fix the board", null);
		expect(prompt).toContain("/shell/run");
		expect(prompt).toContain("paneId=$ODIN_PANE_ID");
	});

	// Long items with their own options and reasons read like the transcript.
	it("keeps each action item to one short line", () => {
		expect(buildPrompt("Fix the board", null)).toContain("One line per item");
	});

	// Settings -> Sessions -> Default prompt replaces the standing ending.
	it("ends with your own instructions in place of the default", () => {
		const prompt = buildPrompt(
			"Fix the board",
			null,
			[],
			undefined,
			false,
			[],
			"",
			"",
			"Reply in haiku.",
		);
		expect(prompt.endsWith("Reply in haiku.")).toBe(true);
		expect(prompt).not.toContain("ACTION ITEMS");
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

describe("buildPrompt and worktrees", () => {
	const build = (
		checkout: string,
		worktree: { path: string; branch: string } | null = null,
	) =>
		buildPrompt(
			"Fix",
			null,
			[],
			undefined,
			false,
			[],
			checkout,
			"",
			"End.",
			worktree,
		);

	it("names the worktree Odin made, and asks for none", () => {
		const prompt = build("/r/.worktrees/fix-ab12", {
			path: "/r/.worktrees/fix-ab12",
			branch: "fix-ab12",
		});
		expect(prompt).toContain("own git worktree: /r/.worktrees/fix-ab12");
		expect(prompt).not.toContain(WORKTREE_ASK_LINE);
	});

	it("tells a session in the repos folder how to get one", () => {
		expect(build("")).toContain(WORKTREE_ASK_LINE);
	});

	it("says nothing in a checkout Odin couldn't branch", () => {
		const prompt = build("/r");
		expect(prompt).not.toContain("worktree");
	});
});

describe("buildPrompt with rules", () => {
	const rule = (action: string, paused?: boolean) => ({
		id: action,
		when: "you open a pull request",
		action,
		paused,
	});

	it("hands the agent every rule that's switched on", () => {
		const prompt = buildPrompt("Fix it", null, [], undefined, false, [
			rule("run /pr-iterate"),
			rule("run /code-review", true),
		]);
		expect(prompt).toContain("- When you open a pull request: run /pr-iterate");
		expect(prompt).not.toContain("/code-review");
	});

	it("says nothing about rules when there are none", () => {
		expect(buildPrompt("Fix it", null)).not.toContain("Standing rules");
		expect(
			buildPrompt("Fix it", null, [], undefined, false, [rule("x", true)]),
		).not.toContain("Standing rules");
	});

	it("hands the agent the context added at start, and nothing when blank", () => {
		const prompt = (guidelines: string) =>
			buildPrompt("Fix it", null, [], undefined, false, [], "", guidelines);
		expect(prompt("Explain in plain words")).toContain(
			"Explain in plain words",
		);
		expect(prompt("  \n ")).not.toContain("Context and guidelines");
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
