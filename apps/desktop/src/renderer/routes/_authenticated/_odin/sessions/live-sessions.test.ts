import { describe, expect, it } from "vitest";
import { liveConversationIds } from "./live-sessions";

describe("liveConversationIds", () => {
	it("collects only conversations whose pane still has a live PTY", () => {
		const live = liveConversationIds(
			[
				{ sessionId: "pane-live", isAlive: true },
				{ sessionId: "pane-mirrored", isAlive: true },
				{ sessionId: "pane-dead", isAlive: false },
				{ sessionId: "pane-hand-opened", isAlive: true },
			],
			{
				"pane-live": { claudeSessionId: "conv-live" },
				"pane-dead": { claudeSessionId: "conv-dead" },
				"pane-hand-opened": {},
			},
			{ "pane-mirrored": "conv-mirrored" },
		);
		expect(live).toEqual(new Set(["conv-live", "conv-mirrored"]));
	});
});
