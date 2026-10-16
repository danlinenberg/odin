import { describe, expect, test } from "bun:test";
import {
	actionItemList,
	applyLines,
	applyQueue,
	arrived,
	bangCommands,
	elapsedLabel,
	interruptClaude,
	isAnswerItem,
	isApprovalItem,
	isDoneItem,
	isEchoed,
	isYouOnly,
	itemDetail,
	itemOptions,
	itemReply,
	lastActionsId,
	launchAttachments,
	launchRequest,
	outputTokens,
	runItemIndex,
	segments,
	splitActionItems,
	splitEarlier,
	tokenLabel,
	toolDescription,
	transcriptPath,
	userText,
	yourQueued,
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

	test("a built-in command's output shows; its caveat doesn't", () => {
		expect(
			userText(
				"<local-command-stdout>\x1b[1mTotal cost:\x1b[22m $0.12</local-command-stdout>",
			),
		).toBe("Total cost: $0.12");
		expect(
			userText("<local-command-stdout></local-command-stdout>"),
		).toBeNull();
		expect(
			userText("<local-command-caveat>Caveat: ...</local-command-caveat>"),
		).toBeNull();
	});

	test("a ! command shows as typed, then its output", () => {
		expect(userText("<bash-input>df -h</bash-input>")).toBe("!df -h");
		expect(
			userText("<bash-stdout>ok</bash-stdout><bash-stderr>warn</bash-stderr>"),
		).toBe("ok\n\nwarn");
	});

	test("a ! block becomes a command to run; other blocks don't", () => {
		const text = [
			"Run this:",
			"```",
			"! aws sso login",
			"```",
			"Not this:",
			"```bash",
			"ls -la",
			"```",
			"```",
			"!echo a &&",
			"echo b",
			"```",
		].join("\n");
		expect(bangCommands(text)).toEqual(["aws sso login", "echo a &&\necho b"]);
	});

	test("! commands sit under the first item that says to run them", () => {
		expect(
			runItemIndex([
				"Decide the branch",
				"Press Run on the blocks above",
				"Run it again",
			]),
		).toBe(1);
		expect(runItemIndex(["Merge #12", "Pruned the runner"])).toBe(-1);
	});

	test("a message sent mid-turn shows as yours, its image too", () => {
		const items = applyLines(
			[],
			[
				{
					type: "attachment",
					uuid: "q1",
					attachment: {
						type: "queued_command",
						prompt: [
							{ type: "text", text: "also this[Image #1]" },
							{
								type: "image",
								source: {
									type: "base64",
									media_type: "image/png",
									data: "AAAA",
								},
							},
						],
					},
				},
			],
		);
		expect(items).toEqual([
			{
				kind: "user",
				id: "q1:0",
				text: "also this",
				images: ["data:image/png;base64,AAAA"],
			},
		]);
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

	test("tool runs fold into one group", () => {
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
		expect((out[1] as unknown[]).length).toBe(3);
	});

	test("narration between two runs stays visible; only tools fold", () => {
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
		expect(out.map((s) => (Array.isArray(s) ? s.length : s.id))).toEqual([
			"a",
			1,
			"b",
			1,
			"c",
			1,
			"d",
		]);
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

	test("only the latest reply with action items shows its card", () => {
		const text = (id: string, t: string) => ({
			kind: "text" as const,
			id,
			text: t,
		});
		expect(
			lastActionsId([
				text("a", "x\nACTION ITEMS:\n1. Merge it"),
				text("b", "y\nACTION ITEMS:\n1. Merge it"),
				text("c", "no list here"),
			]),
		).toBe("b");
		expect(lastActionsId([text("a", "no list")])).toBeUndefined();
	});

	test("an item's tooltip is the reply paragraph that explains it", () => {
		const body =
			"Pushed the docs.\n\n`training-profiles.md` lists profiles that no longer exist.\n\nThe notifications bug and the Pic-Time auth bug both 500 on retry.";
		expect(
			itemDetail(
				"Tell me what to do with `training-profiles.md` [delete | keep]",
				body,
			),
		).toBe("`training-profiles.md` lists profiles that no longer exist.");
		expect(
			itemDetail(
				"Tell me whether to ticket the notifications and Pic-Time auth bugs",
				body,
			),
		).toStartWith("The notifications bug");
		expect(itemDetail("Restart Odin dev", body)).toBeNull();
	});

	test("a paragraph that names the item by number explains it", () => {
		const body =
			"Built the picker.\n\n**Limit:** SSM-only access is still waiting on your answer (item 3 below).";
		expect(itemDetail("Choose access for the box", body, 3)).toStartWith(
			"**Limit:**",
		);
		expect(itemDetail("Choose access for the box", body, 13)).toBeNull();
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
		expect(
			itemOptions(
				"Update main now. [yes | after [#826](https://x/826) merges]",
			),
		).toEqual({
			text: "Update main now.",
			options: ["yes", "after #826 merges"],
		});
		expect(
			itemOptions("Decide #903 [merge | close] [https://x/903](https://x/903)"),
		).toEqual({
			text: "Decide #903 [https://x/903](https://x/903)",
			options: ["merge", "close"],
		});
		expect(itemOptions("Decide [merge | close] https://x/903")).toEqual({
			text: "Decide https://x/903",
			options: ["merge", "close"],
		});
		expect(itemOptions("Tell me the seniority.").options).toEqual([]);
		expect(
			itemOptions("Pick a fix [extension | write around it] (you only)"),
		).toEqual({
			text: "Pick a fix",
			options: ["extension", "write around it"],
		});
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

describe("itemReply", () => {
	test("an empty answer box sends the item itself", () => {
		expect(itemReply("Tell me commit and push to update PR #760", "  ")).toBe(
			undefined,
		);
	});
	test("a typed answer, or Done for a tell-me-when item", () => {
		expect(itemReply("Tell me which repo to use", " odin ")).toBe("odin");
		expect(itemReply("Tell me when you have signed in", "")).toBe("Done");
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

test("output tokens count each message once, at its largest", () => {
	const line = (id: string, out: number, block: object) => ({
		type: "assistant",
		uuid: `${id}-${out}`,
		message: { id, usage: { output_tokens: out }, content: [block] },
	});
	const items = applyLines(
		[],
		[
			line("m1", 3, { type: "text", text: "Looking" }),
			line("m1", 400, { type: "tool_use", id: "t1", name: "Bash", input: {} }),
			line("m2", 1800, { type: "text", text: "Done" }),
		],
	);
	expect(outputTokens(items)).toBe(2200);
	expect(tokenLabel(840)).toBe("840");
	expect(tokenLabel(2200)).toBe("2.2k");
	expect(tokenLabel(12_400)).toBe("12k");
});

describe("elapsedLabel", () => {
	test("seconds, then minutes, then hours", () => {
		expect(elapsedLabel(42_000)).toBe("42s");
		expect(elapsedLabel(185_000)).toBe("3m 05s");
		expect(elapsedLabel(3_720_000)).toBe("1h 02m");
		expect(elapsedLabel(-5)).toBe("0s");
	});
});

test("a user turn keeps when it was sent", () => {
	const [item] = applyLines(
		[],
		[
			{
				type: "user",
				timestamp: "2026-10-10T10:00:00Z",
				message: { content: "hi" },
			},
		],
	);
	expect(item).toMatchObject({
		kind: "user",
		at: Date.parse("2026-10-10T10:00:00Z"),
	});
});

describe("splitEarlier", () => {
	const bytes = (text: string) => new TextEncoder().encode(text);
	const text = (data: Uint8Array) => new TextDecoder().decode(data);

	test("joins the cut line back together, and keeps the new cut", () => {
		// File: {"a":1}\n{"b":"é"}\n{"c":3}\n - the window began inside line two,
		// mid "é" (two bytes), and the earlier chunk ends at the same byte.
		const file = bytes('{"a":1}\n{"b":"é"}\n{"c":3}\n');
		const cut = file.indexOf(0xa9); // second byte of é
		const window = file.subarray(cut);
		const head = window.subarray(0, window.indexOf(10));
		const middle = splitEarlier(file.subarray(3, cut), head, false);
		expect(middle.lines).toEqual(['{"b":"é"}']);
		expect(text(middle.head)).toBe('":1}');
		const first = splitEarlier(file.subarray(0, 3), middle.head, true);
		expect(first.lines).toEqual(['{"a":1}']);
		expect(first.head.length).toBe(0);
	});
});

describe("applyQueue", () => {
	const op = (operation: string, content?: string) =>
		({ type: "queue-operation", operation, content }) as never;
	test("holds what Claude queued until it takes or drops it", () => {
		let queue = applyQueue(
			[],
			[op("enqueue", "first"), op("enqueue", "second")],
		);
		expect(queue).toEqual(["first", "second"]);
		queue = applyQueue(queue, [op("dequeue")]);
		expect(queue).toEqual(["second"]);
		queue = applyQueue(queue, [op("remove", "second")]);
		expect(queue).toEqual([]);
		// A task notice holds its place in the queue but is not shown as yours.
		const withNotice = applyQueue(
			[],
			[
				op("enqueue", "<task-notification>x</task-notification>"),
				op("enqueue", "mine"),
			],
		);
		expect(yourQueued(withNotice)).toEqual(["mine"]);
		expect(applyQueue(withNotice, [op("dequeue")])).toEqual(["mine"]);
		// Esc pulls everything back into the input.
		expect(applyQueue(withNotice, [op("popAll", "mine")])).toEqual([]);
	});
	test("a message that lands as a turn leaves the queue, older leftovers too", () => {
		// A real log: a resume left a notice and "Continue" behind, so the
		// dequeue that took "dsasda" shifted "Continue" instead.
		let queue = applyQueue(
			[],
			[
				op("enqueue", "<task-notification>x</task-notification>"),
				op("enqueue", "Continue"),
				op("enqueue", "dsasda"),
				op("dequeue"),
			],
		);
		expect(yourQueued(queue)).toEqual(["Continue", "dsasda"]);
		queue = applyQueue(queue, [
			{ type: "user", message: { content: "dsasda" } } as never,
		]);
		expect(queue).toEqual([]);
		// Mid-turn, it lands as a queued_command attachment.
		queue = applyQueue(
			["later"],
			[{ attachment: { type: "queued_command", prompt: "later" } } as never],
		);
		expect(queue).toEqual([]);
	});
});

describe("ChatView sent bubble", () => {
	const old = { kind: "user", id: "a", text: "earlier message" };
	test("a photo sent alone stays until a new row echoes it", () => {
		const sent = { text: "", seen: new Set(["a"]) };
		expect(isEchoed([old], sent)).toBe(false);
		expect(isEchoed([old, { kind: "user", id: "b", text: "" }], sent)).toBe(
			true,
		);
	});
	test("an older row with the same words is not the echo", () => {
		const sent = { text: "ok", seen: new Set(["a"]) };
		expect(isEchoed([{ ...old, text: "ok then" }], sent)).toBe(false);
	});
});

describe("arrived - Claude took the sent message", () => {
	const sent = { text: "fix it", seen: new Set(["a"]) };
	const old = { kind: "user", id: "a" };
	test("nothing new and nothing queued: never got there", () => {
		expect(arrived([old], [], sent)).toBe(false);
	});
	test("queued mid-turn counts", () => {
		expect(arrived([old], ["fix it"], sent)).toBe(true);
	});
	test("any new user row counts - Claude rewrites some messages", () => {
		expect(arrived([old, { kind: "user", id: "b" }], [], sent)).toBe(true);
	});
});

describe("interruptClaude", () => {
	const idle = `❯ \n${"─".repeat(20)}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)`;
	const busy = `✻ Cogitating… (5m 0s · ↓ 1k tokens)\n${"─".repeat(20)}\n❯ \n${"─".repeat(20)}\n  ⏵⏵ bypass permissions on`;
	const run = async (screens: (string | null)[]) => {
		const writes: string[] = [];
		const sent = await interruptClaude(
			async ({ data }) => writes.push(data),
			async () => ({ text: screens.shift() ?? null }),
			"pane",
		);
		return { sent, writes };
	};
	test("mid-turn: Ctrl+C, never Esc", async () => {
		expect(await run([busy])).toEqual({ sent: true, writes: ["\x03"] });
	});
	test("at the prompt: no Ctrl+C - it would stop the background agents", async () => {
		expect(await run([idle, idle])).toEqual({ sent: false, writes: [] });
	});
	test("the message Claude put back in its box is cleared", async () => {
		const restored = `${"─".repeat(20)}\n❯ line one\n  line two\n${"─".repeat(20)}\n  ⏵⏵ bypass permissions on`;
		expect(await run([busy, restored])).toEqual({
			sent: true,
			writes: ["\x03", "\x15\x7f\x15\x7f\x15"],
		});
	});
	test("an unreadable screen still interrupts", async () => {
		expect(await run([null])).toEqual({ sent: true, writes: ["\x03"] });
	});
});
