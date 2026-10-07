import { describe, expect, test } from "bun:test";
import { applyLines, transcriptPath, userText } from "./ChatView";

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
});
