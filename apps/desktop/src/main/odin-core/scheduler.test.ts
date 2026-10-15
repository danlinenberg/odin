import { describe, expect, it } from "bun:test";
import { statusFromAgentEvent } from "shared/server-board";
import { slackLaunchInput, slackRowsToStart } from "./scheduler";

const row = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	title: `Message ${id}`,
	text: `Please look at ${id}`,
	permalink: `https://x.slack.com/archives/C1/p${id}`,
	authorName: "Dana",
	autoLaunch: true,
	...extra,
});

describe("Slack auto-launch on the server", () => {
	it("starts only reacted rows it hasn't tried", () => {
		const rows = [row("1"), row("2", { autoLaunch: false }), row("3")];
		expect(slackRowsToStart(rows, ["3"]).map((r) => r.id)).toEqual(["1"]);
	});

	it("launches the way the window's auto-start does", () => {
		const input = slackLaunchInput(row("7"));
		expect(input).toMatchObject({
			key: "7",
			title: "Message 7",
			contact: "Dana",
			brief: "Please look at 7",
			pageId: "7",
			source: "reactions",
			tags: ["auto-started"],
			origin: "slack",
			slackRowId: "7",
		});
		// The thread link leads the prompt - the board finds a session's thread by it.
		expect(input?.description?.split("\n")[0]).toBe(
			"This task comes from a Slack thread: https://x.slack.com/archives/C1/p7",
		);
	});

	it("skips a row with no link to hand the session", () => {
		expect(slackLaunchInput(row("8", { permalink: null }))).toBeNull();
	});
});

describe("statusFromAgentEvent", () => {
	it("reads host agent events as board statuses", () => {
		expect(statusFromAgentEvent("Start")).toBe("working");
		expect(statusFromAgentEvent("PermissionRequest")).toBe("permission");
		expect(statusFromAgentEvent("Stop")).toBe("review");
		expect(statusFromAgentEvent(null)).toBe("idle");
	});
});
