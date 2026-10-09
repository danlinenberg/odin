import { describe, expect, test } from "bun:test";
import {
	actionItemList,
	applyLines,
	groupSummary,
	isAnswerItem,
	isApprovalItem,
	isDoneItem,
	isYouOnly,
	itemOptions,
	launchAttachments,
	launchRequest,
	segments,
	splitActionItems,
	toolDescription,
	transcriptPath,
	userText,
} from "./ChatView";

describe("ChatView transcript", () => {
	test("files the transcript under the cwd with non-alphanumerics as dashes", () => {
		expect(transcriptPath("/Users/d", "/Users/d/dev/x.y", "abc")).toBe(
			"/Users/d/.claude/projects/-Users-d-dev-x-y/abc.jsonl",
		);
	});

	test("user text drops hook chatter and shows a slash command as itself", () => {
		expect(userText("<system-reminder>x</system-reminder>")).toBeNull();
		expect(userText("<command-name>/compact</command-name>")).toBe("/compact");
		expect(userText("hi <system-reminder>x</system-reminder>")).toBe("hi");
	});

	test("a ! command shows as typed, then its output", () => {
		expect(userText("<bash-input>df -h</bash-input>")).toBe("!df -h");
		expect(
			userText("<bash-stdout>ok</bash-stdout><bash-stderr>warn</bash-stderr>"),
		).toBe("ok\n\nwarn");
	});

	test("a message sent mid-turn shows as yours", () => {
		const items = applyLines(
			[],
			[
				{
					type: "attachment",
					uuid: "q1",
					attachment: {
						type: "queued_command",
						prompt: [{ type: "text", text: "also this" }],
					},
				},
			],
		);
		expect(items).toEqual([{ kind: "user", id: "q1", text: "also this" }]);
	});

	test("a pasted image shows in its bubble, minus the [Image #N] tag", () => {
		const image = {
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "AAAA" },
		};
		const items = applyLines(
			[],
			[
				{
					type: "user",
					uuid: "u1",
					message: {
						content: [{ type: "text", text: "[Image #2] look" }, image],
					},
				},
				{ type: "user", uuid: "u2", message: { content: [image] } },
			],
		);
		expect(items).toEqual([
			{
				kind: "user",
				id: "u1:0",
				text: "look",
				images: ["data:image/png;base64,AAAA"],
			},
			{
				kind: "user",
				id: "u2",
				text: "",
				images: ["data:image/png;base64,AAAA"],
			},
		]);
	});

	test("a compaction is one row with its summary folded in, not a message", () => {
		const items = applyLines(
			[],
			[
				{
					type: "system",
					subtype: "compact_boundary",
					uuid: "b",
					timestamp: "2026-10-08T09:32:51.520Z",
					compactMetadata: { preTokens: 378462, postTokens: 41000 },
				},
				{
					type: "user",
					uuid: "s",
					isCompactSummary: true,
					message: { content: "Summary: long" },
				},
			],
		);
		expect(items).toEqual([
			{
				kind: "compact",
				id: "b",
				at: Date.parse("2026-10-08T09:32:51.520Z"),
				preTokens: 378462,
				postTokens: 41000,
				durationMs: undefined,
				summary: "Summary: long",
			},
		]);
	});

	test("a tool result fills in its tool row; meta lines are skipped", () => {
		const items = applyLines(
			[],
			[
				{ type: "user", uuid: "u1", message: { content: "fix it" } },
				{ type: "user", uuid: "m", isMeta: true, message: { content: "meta" } },
				{
					type: "assistant",
					uuid: "a1",
					message: {
						content: [
							{ type: "text", text: "On it." },
							{
								type: "tool_use",
								id: "t1",
								name: "Bash",
								input: { command: "ls" },
							},
						],
					},
				},
			],
		);
		const done = applyLines(items, [
			{
				type: "user",
				uuid: "r1",
				message: {
					content: [
						{ type: "tool_result", tool_use_id: "t1", content: "a.ts" },
					],
				},
			},
		]);
		expect(done.map((item) => item.kind)).toEqual(["user", "text", "tool"]);
		expect(done[2]).toMatchObject({ kind: "tool", result: "a.ts" });
		expect(done[0]).toBe(items[0]);
	});

	test("tool runs fold into one group with a counted summary", () => {
		const tool = (id: string, name: string) =>
			({ kind: "tool", id, name, input: {} }) as const;
		const out = segments([
			{ kind: "text", id: "a", text: "hi" },
			tool("1", "Bash"),
			tool("2", "Bash"),
			tool("3", "Read"),
			{ kind: "text", id: "b", text: "done" },
		]);
		expect(out.length).toBe(3);
		expect(groupSummary(out[1] as never)).toBe("Ran 2 commands, read 1 file");
	});

	test("narration between two runs folds into one group; the last reply stays", () => {
		const tool = (id: string, name: string) =>
			({ kind: "tool", id, name, input: {} }) as const;
		const out = segments([
			{ kind: "text", id: "a", text: "first" },
			tool("1", "Bash"),
			{ kind: "text", id: "b", text: "next" },
			tool("2", "Bash"),
			{ kind: "text", id: "c", text: "and" },
			tool("3", "Write"),
			{ kind: "text", id: "d", text: "done" },
		]);
		expect(out.length).toBe(3);
		expect(groupSummary(out[1] as never)).toBe("Ran 2 commands, wrote 1 file");
		expect((out[2] as { id: string }).id).toBe("d");
	});

	test("action items split off in the shapes agents write them", () => {
		expect(splitActionItems("Done.\n\nACTION ITEMS:\n1. Merge it")).toEqual({
			body: "Done.",
			actions: "1. Merge it",
		});
		expect(splitActionItems("x\n**ACTION ITEMS:** none - all shipped")).toEqual(
			{
				body: "x",
				actions: "none - all shipped",
			},
		);
		expect(splitActionItems("## Action items\n- a").actions).toBe("- a");
		expect(splitActionItems("no list here").actions).toBeNull();
	});

	test("action items list one entry per numbered or bulleted line", () => {
		expect(actionItemList("1. Merge it\n2) Check `x` works")).toEqual([
			"Merge it",
			"Check `x` works",
		]);
		expect(actionItemList("- a\n* b")).toEqual(["a", "b"]);
		expect(actionItemList("none - all shipped")).toEqual([]);
	});

	test("an item asking you to approve something gets the Approve button", () => {
		expect(
			isApprovalItem("Approve a commit and PR, or tell me to hold. (you only)"),
		).toBe(true);
		expect(isApprovalItem("**Approve** the plan")).toBe(true);
		expect(isApprovalItem("Decide whether to approve the PR")).toBe(false);
		expect(isApprovalItem("Approved PRs need nothing")).toBe(false);
	});

	test("an item asking you to tell Claude something gets a reply box", () => {
		expect(isAnswerItem("Tell me the target seniority.")).toBe(true);
		expect(isAnswerItem("**Pick** a name")).toBe(true);
		expect(isAnswerItem("Merge PR #12")).toBe(false);
		expect(
			isAnswerItem("Tell me when you have authorized, so I can run the test."),
		).toBe(false);
		expect(
			isDoneItem("Tell me when you have authorized, so I can run the test."),
		).toBe(true);
		expect(isDoneItem("Let me know once it is merged")).toBe(true);
		expect(isDoneItem("Tell me the target seniority.")).toBe(false);
		expect(isDoneItem("Tell me when to ship [today | tomorrow]")).toBe(false);
	});

	test("trailing [A | B] choices become buttons", () => {
		expect(itemOptions("Tell me the format [CSV | shareable page].")).toEqual({
			text: "Tell me the format",
			options: ["CSV", "shareable page"],
		});
		expect(itemOptions("Open [the PR](https://x)").options).toEqual([]);
		expect(itemOptions("Tell me the seniority.").options).toEqual([]);
	});
});

describe("launchAttachments - the images and videos a launch prompt attached", () => {
	test("lists image and video paths, skipping other files and the ffmpeg hint", () => {
		const prompt = [
			"Task: fix it",
			"",
			"Attached files - read them before starting:",
			"/Users/dan/dev/.odin/attachments/a b.png",
			"/Users/dan/dev/.odin/attachments/clip.mp4",
			"/Users/dan/dev/.odin/attachments/notes.txt",
			"",
			"Videos can't be read directly - pull frames first.",
		].join("\n");
		expect(launchAttachments(prompt)).toEqual([
			"/Users/dan/dev/.odin/attachments/a b.png",
			"/Users/dan/dev/.odin/attachments/clip.mp4",
		]);
		expect(launchAttachments("Task: no files")).toEqual([]);
	});
});

describe("launchRequest - the request you typed, without the launcher's scaffolding", () => {
	test("folds a task prompt to its title, before the attachment list", () => {
		const prompt = [
			"Task: improve text formatting",
			"",
			"Attached files - read them before starting:",
			"/Users/dan/dev/.odin/attachments/a.png",
			"",
			"Work in the current workspace. Investigate, make the changes.",
		].join("\n");
		expect(launchRequest(prompt)).toBe("Task: improve text formatting");
	});

	test("keeps the description and folds at the first scaffold block", () => {
		const prompt = [
			"Task: ship the thing",
			"",
			"Make it fast.\nAnd small.",
			"",
			"Standing rules - follow each one whenever its situation comes up during this session, without being asked:\n- When you open a pull request: auto merge",
			"",
			"Work in the current workspace. Investigate.",
		].join("\n");
		expect(launchRequest(prompt)).toBe(
			"Task: ship the thing\n\nMake it fast.\nAnd small.",
		);
	});

	test("folds a skill launch at the guidelines the person added", () => {
		const prompt = [
			"/triage ODIN-12",
			"",
			"Context and guidelines from me for this session - keep them in mind throughout:\nUse the staging DB.",
		].join("\n");
		expect(launchRequest(prompt)).toBe("/triage ODIN-12");
	});

	test("returns null for a typed message with no scaffolding", () => {
		expect(launchRequest("Can you check the build?\n\nThanks")).toBeNull();
		expect(launchRequest("Task: only a title")).toBeNull();
	});
});

describe("isYouOnly", () => {
	test("a plain (you only) item gets no button", () => {
		expect(isYouOnly("Reload the Odin window (you only).")).toBe(true);
	});
	test("an item Claude can do, or one asking for an answer, still gets one", () => {
		expect(isYouOnly("Look at #740 if CI fails.")).toBe(false);
		expect(isYouOnly("Tell me which repo to use (you only).")).toBe(false);
	});
});

describe("toolDescription", () => {
	test("a command reads as the description Claude gave it", () => {
		expect(
			toolDescription({
				name: "Bash",
				input: { command: "gh pr checks 768 --watch", description: "Watch CI" },
			}),
		).toBe("Watch CI");
	});
	test("a file tool reads as the file it touched", () => {
		expect(
			toolDescription({
				name: "Edit",
				input: { file_path: "/a/b/ChatView.tsx" },
			}),
		).toBe("Edited ChatView.tsx");
	});
	test("a command with no description falls back to the command", () => {
		expect(toolDescription({ name: "Bash", input: { command: "ls" } })).toBe(
			"Bash ls",
		);
	});
});
