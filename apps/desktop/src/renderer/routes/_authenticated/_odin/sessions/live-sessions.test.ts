import { describe, expect, it } from "bun:test";
import { boardConversationIds } from "./live-sessions";

describe("boardConversationIds", () => {
	it("collects every card's conversation, dead PTY included, but not Done ones", () => {
		const ids = boardConversationIds(
			{
				"pane-live": { claudeSessionId: "conv-live" },
				"pane-dead-pty": { claudeSessionId: "conv-dead-pty" },
				"pane-done": { claudeSessionId: "conv-done", completed: true },
				"pane-mirrored": {},
				"pane-hand-opened": {},
			},
			{ "pane-mirrored": "conv-mirrored" },
		);
		expect(ids).toEqual(
			new Set(["conv-live", "conv-dead-pty", "conv-mirrored"]),
		);
	});
});
