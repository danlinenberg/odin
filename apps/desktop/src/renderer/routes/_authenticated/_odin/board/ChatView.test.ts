import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { remoteConnectLine } from "shared/odin-screen-status";
import {
	actionItemEntries,
	actionItemList,
	applyLines,
	applyQueue,
	arrived,
	autoSsoLogin,
	bangCommands,
	bashCommandOf,
	commandItem,
	currentTurn,
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
	itemsFoldLabel,
	LIMIT_HIT_RE,
	lastActionsId,
	launchAttachments,
	launchRequest,
	leavePhase,
	messageAttachments,
	nextHostStep,
	outputTokens,
	segments,
	shownTldr,
	splitActionItems,
	splitEarlier,
	ToolGroup,
	tokenLabel,
	toolDescription,
	transcriptPath,
	userText,
	withoutAttachments,
	withoutMediaPaths,
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

	test("a built-in command's caveat doesn't show", () => {
		expect(
			userText("<local-command-caveat>Caveat: ...</local-command-caveat>"),
		).toBeNull();
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

	test("a ! command goes under its own item, else the one naming it, else the one saying run", () => {
		const items = [
			"Optional: install the Datadog agent now (you only):",
			"Approve terraform PR #1234",
			"Reboot the box with `aws ec2 reboot-instances`",
		];
		const agent =
			'DD_API_KEY=x bash -c "$(curl -L https://install.datadoghq.com/scripts/install_script_agent7.sh)"';
		const reboot = "aws ec2 reboot-instances --instance-ids i-0abc";
		expect(commandItem(reboot, items, [[], [reboot], []])).toBe(1);
		expect(commandItem(agent, items)).toBe(0);
		expect(commandItem(reboot, items)).toBe(2);
		expect(commandItem("gh pr merge 1234", items)).toBe(1);
		expect(commandItem("ls", ["Decide the branch", "Press Run below"])).toBe(1);
		expect(commandItem("ls", ["Merge #12", "Pruned the runner"])).toBe(-1);
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

	test("no action items card while Claude works", () => {
		const reply = {
			kind: "text" as const,
			id: "a",
			text: "x\nACTION ITEMS:\n1. Merge it",
		};
		expect(lastActionsId([reply], true)).toBeUndefined();
		expect(lastActionsId([reply], false)).toBe("a");
	});

	test("a card told to go collapses away before it leaves the tree", () => {
		expect(leavePhase("open", false)).toBe("leaving");
		expect(leavePhase("entering", false)).toBe("leaving");
		expect(leavePhase("gone", false)).toBe("gone");
	});

	test("a card that comes late to its row fades in; one on its way out grows back", () => {
		expect(leavePhase("gone", true)).toBe("entering");
		expect(leavePhase("leaving", true)).toBe("open");
		expect(leavePhase("open", true)).toBe("open");
	});

	test("the TL;DR stays while Claude works, without its Needs you mark", () => {
		const fresh = {
			last: "Merge it",
			urgency: "needs-you" as const,
			long: true,
		};
		expect(shownTldr(fresh, { working: true, tldrOnly: false })).toEqual({
			...fresh,
			urgency: null,
		});
		expect(shownTldr(fresh, { working: false, tldrOnly: false })).toEqual(
			fresh,
		);
		expect(shownTldr(fresh, { working: false, tldrOnly: true })).toEqual({
			...fresh,
			urgency: null,
		});
		expect(shownTldr(null, { working: true, tldrOnly: false })).toBeNull();
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

	test("a fenced block between items belongs to the item above it", () => {
		const fence = "   ```\n   ! echo a\n   - not an item\n   ```";
		expect(
			actionItemEntries(`1. Install the agent:\n${fence}\n2. Approve the PR`),
		).toEqual([
			{ text: "Install the agent:", fences: [fence] },
			{ text: "Approve the PR", fences: [] },
		]);
		expect(bangCommands(fence)).toEqual(["echo a\n   - not an item"]);
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

	test("includes a path on its own line in the request", () => {
		const prompt =
			"Task: stuck\n\n/Users/dan/.odin/attachments/shot.png\n\nWork in the current workspace.";
		expect(launchAttachments(prompt)).toEqual([
			"/Users/dan/.odin/attachments/shot.png",
		]);
	});

	test("a title that is only a pasted screenshot's path counts", () => {
		const prompt =
			"Task: /Users/dan/.odin/attachments/shot.png\n\nWork in the current workspace.";
		expect(launchAttachments(prompt)).toEqual([
			"/Users/dan/.odin/attachments/shot.png",
		]);
		expect(
			launchAttachments("Task: /Users/dan/notes.txt\n\nWork in it."),
		).toEqual([]);
	});
});

describe("withoutMediaPaths - the folded request minus the paths its previews show", () => {
	test("drops a path line, or a title that is one, only once its preview shows", () => {
		const request = "Task: /a/shot.png\n\nSee also\n/a/clip.mp4";
		expect(
			withoutMediaPaths(request, new Set(["/a/shot.png", "/a/clip.mp4"])),
		).toBe("See also");
		expect(withoutMediaPaths(request, new Set(["/a/shot.png"]))).toBe(
			"See also\n/a/clip.mp4",
		);
		expect(withoutMediaPaths(request, new Set())).toBe(request);
	});
});

describe("messageAttachments - the images and videos a typed message names", () => {
	test("a follow-up's screenshot path after the words, the host's copy included", () => {
		expect(
			messageAttachments(
				"why? /home/ubuntu/.odin/files/0-1792585952956-7y4nec.png",
			),
		).toEqual(["/home/ubuntu/.odin/files/0-1792585952956-7y4nec.png"]);
		expect(messageAttachments("look /Users/dan/shot.png please")).toEqual([
			"/Users/dan/shot.png",
		]);
	});

	test("a path with spaces and dots in it, up to its own extension", () => {
		expect(
			messageAttachments(
				"see /Users/dan/v1.2 notes/Screenshot 2026-10-21 at 15.32.11.png.",
			),
		).toEqual(["/Users/dan/v1.2 notes/Screenshot 2026-10-21 at 15.32.11.png"]);
	});

	test("two paths on a line, a video, and a file that is neither", () => {
		expect(
			messageAttachments(
				"/Users/dan/notes.txt and /Users/dan/a.png /home/u/.odin/files/1-clip.mov\nnothing here",
			),
		).toEqual(["/Users/dan/a.png", "/home/u/.odin/files/1-clip.mov"]);
		expect(messageAttachments("run ./build.png now")).toEqual([]);
	});
});

describe("withoutAttachments - a typed message minus the paths its previews show", () => {
	const copy = "/home/ubuntu/.odin/files/0-shot.png";

	test("a path at the end or start of a line goes, one mid-sentence stays", () => {
		expect(withoutAttachments(`why? ${copy}`, new Set([copy]))).toBe("why?");
		expect(withoutAttachments(`${copy} why?`, new Set([copy]))).toBe("why?");
		expect(withoutAttachments(`see ${copy} here`, new Set([copy]))).toBe(
			`see ${copy} here`,
		);
	});

	test("a line that was only paths goes; a path not yet shown stays", () => {
		expect(
			withoutAttachments(
				`look\n${copy} /a/b.png\nok`,
				new Set([copy, "/a/b.png"]),
			),
		).toBe("look\nok");
		expect(withoutAttachments(`why? ${copy}`, new Set())).toBe(`why? ${copy}`);
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

describe("itemsFoldLabel - the action items card folds its own items", () => {
	test("open card offers to hide the items", () => {
		expect(itemsFoldLabel(false, 5)).toBe("Hide items");
	});
	test("folded card counts what it hides", () => {
		expect(itemsFoldLabel(true, 5)).toBe("Show 5 items");
		expect(itemsFoldLabel(true, 1)).toBe("Show 1 item");
	});
});

test("autoSsoLogin signs in on its own only for a fresh expired-token reply", () => {
	const text = "Token expired. Run 'aws sso login' to refresh.";
	const now = 1_800_000_000_000;
	expect(autoSsoLogin({ id: "a", text, at: now - 60_000 }, now)).toBe(true);
	expect(autoSsoLogin({ id: "b", text, at: now - 11 * 60_000 }, now)).toBe(
		false,
	);
	expect(autoSsoLogin({ id: "c", text }, now)).toBe(false);
	expect(autoSsoLogin({ id: "d", text: "all good", at: now }, now)).toBe(false);
});

test("LIMIT_HIT_RE matches Claude's usage and spend limit lines", () => {
	expect(
		LIMIT_HIT_RE.test(
			"You've hit your weekly limit · resets Oct 21, 4am (UTC)",
		),
	).toBe(true);
	expect(
		LIMIT_HIT_RE.test(
			"You’ve hit your individual spend limit · ask your admin",
		),
	).toBe(true);
	expect(LIMIT_HIT_RE.test("We hit the rate limit on the API.")).toBe(false);
});

describe("bashCommandOf", () => {
	// Claude's queue log keeps a queued `!` command's text without the `!`.
	test("tells a queued command from a typed message", () => {
		const ran = new Set(["git push origin main"]);
		expect(bashCommandOf("git push origin main", ran)).toBe(
			"git push origin main",
		);
		expect(bashCommandOf("!ls -la", ran)).toBe("ls -la");
		expect(bashCommandOf("why is this slow?", ran)).toBeNull();
	});
});

describe("commandItem fallback", () => {
	test("gives the button to the item that says to run it, not one that says apply", () => {
		const items = [
			"Approve terraform PR #1540, then comment `terrateam apply`: https://github.com/imagenai/terraform/pull/1540 (you only)",
			"Run the reset command above after #1540 applies (you only)",
		];
		expect(commandItem("systemctl show user.slice", items)).toBe(1);
	});
});

describe("nextHostStep - a remote pane's connect step, read off its screen", () => {
	const rule = "─".repeat(40);
	const claude = `${rule}\n❯\n${rule}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n`;
	const shell = "$ \n";
	const step = (
		last: Parameters<typeof nextHostStep>[0]["last"],
		connecting: string | undefined,
		screen: string | null,
		terminal = true,
	) => nextHostStep({ last, connecting, screen, terminal });

	test("connecting, then connected once Claude is drawn", () => {
		const line = "\nOdin: connecting to i-0abc123...\n";
		expect(step(undefined, remoteConnectLine(line), line)).toBe("connecting");
		expect(step("connecting", undefined, claude)).toBe("connected");
	});

	test("disconnected when Claude leaves the pane, or the pane ends", () => {
		expect(step("connected", undefined, shell)).toBe("disconnected");
		expect(step("connected", undefined, null, false)).toBe("disconnected");
	});

	test("connected again once Claude is drawn after a disconnect", () => {
		// A read between repaints, or a drop the pane reconnected from, said
		// Claude was gone; the next read shows it back. Disconnected used to
		// stay on screen for the rest of the session.
		expect(step("disconnected", undefined, claude)).toBe("connected");
		expect(step("failed", undefined, claude)).toBe("connected");
	});

	test("a failed connect stays failed", () => {
		const failed =
			"\nOdin: connecting to i-0abc123...\n\nOdin: could not connect: TargetNotConnected\n";
		expect(step("failed", remoteConnectLine(failed), failed)).toBeUndefined();
		expect(step("failed", undefined, null, false)).toBeUndefined();
	});

	test("a drop reads as connecting again, not disconnected", () => {
		const dropped = "\nOdin: connection lost - reconnecting to i-0abc123...\n";
		expect(step("connected", remoteConnectLine(dropped), dropped)).toBe(
			"connecting",
		);
	});

	test("leaves the step alone when the screen says nothing new", () => {
		expect(step("connected", undefined, claude)).toBeUndefined();
		expect(step("connected", undefined, null)).toBeUndefined();
		expect(step("disconnected", undefined, shell)).toBeUndefined();
	});
});

describe("currentTurn - the turn the Working row shows", () => {
	const tool = (uuid: string, msg: string, out: number, id: string) => ({
		type: "assistant",
		uuid,
		message: {
			id: msg,
			usage: { output_tokens: out },
			content: [{ type: "tool_use", id, name: "Bash", input: {} }],
		},
	});
	const items = applyLines(
		[],
		[
			{
				type: "user",
				uuid: "u1",
				timestamp: "2026-10-10T10:00:00Z",
				message: { content: "first" },
			},
			tool("a1", "m1", 50, "t1"),
			{
				type: "user",
				uuid: "u2",
				timestamp: "2026-10-10T10:05:00Z",
				message: { content: "second" },
			},
			tool("a2", "m2", 120, "t2"),
			tool("a3", "m3", 30, "t3"),
		],
	);

	test("began with your last message and holds the steps since", () => {
		const turn = currentTurn(items, true);
		expect(turn.id).toBe("u2");
		expect(turn.start).toBe(Date.parse("2026-10-10T10:05:00Z"));
		expect(turn.prompt).toBe("second");
		expect(turn.items.map((item) => item.id)).toEqual(["t2", "t3"]);
		expect(turn.tools.map((item) => item.id)).toEqual(["t2", "t3"]);
		expect(turn.tokens).toBe(150);
	});

	test("a message still on its way shows none of the last turn's steps", () => {
		const turn = currentTurn(items, false);
		expect(turn.items).toEqual([]);
		expect(turn.tools).toEqual([]);
		expect(turn.start).toBeUndefined();
		expect(turn.tokens).toBe(0);
		expect(turn.id).not.toBe("u2");
	});

	test("with no message of yours, the whole transcript is the turn", () => {
		const turn = currentTurn(
			items.filter((item) => item.kind !== "user"),
			true,
		);
		expect(turn.tools.map((item) => item.id)).toEqual(["t1", "t2", "t3"]);
		expect(turn.start).toBeUndefined();
		expect(turn.prompt).toBe("");
		expect(turn.id).toBe("");
	});
});

describe("ToolGroup", () => {
	const group = [
		{ kind: "tool", id: "t1", name: "Bash", input: {}, result: "ok" } as const,
	];

	test("the Worked toggle opens the line, before its first words", () => {
		const html = renderToStaticMarkup(
			createElement(ToolGroup, {
				group,
				lead: createElement("p", null, "Three new findings are confirmed."),
			}),
		);
		const toggle = html.indexOf('aria-label="Worked"');
		const line = html.indexOf("Three new findings");
		expect(toggle).toBeGreaterThan(-1);
		expect(line).toBeGreaterThan(toggle);
		// The line fills the row; the toggle sits on its first row.
		expect(html).toContain('<div class="min-w-0 flex-1"><p>Three new');
		expect(html).toContain("items-start");
	});

	test("alone on its row, the toggle keeps the mark's height", () => {
		const html = renderToStaticMarkup(createElement(ToolGroup, { group }));
		expect(html).toContain("h-7 items-center");
		expect(html).not.toContain("flex-1");
	});
});
