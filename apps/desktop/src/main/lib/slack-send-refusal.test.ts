import { describe, expect, test } from "bun:test";
import { slackSendRefusal } from "./read-link";

describe("slackSendRefusal", () => {
	test("refuses posting and scheduling while sending is off", () => {
		for (const path of [
			"chat.postMessage",
			"/chat.postMessage",
			"chat.scheduleMessage?channel=C0123",
			"chat.update",
		])
			expect(slackSendRefusal("slack", path, false)).toContain(
				"Sending Slack messages is off",
			);
	});

	test("lets reads through, and everything once sending is on", () => {
		expect(
			slackSendRefusal("slack", "conversations.history", false),
		).toBeNull();
		expect(slackSendRefusal("slack", "chat.getPermalink", false)).toBeNull();
		expect(slackSendRefusal("slack", "chat.postMessage", true)).toBeNull();
		expect(slackSendRefusal("github", "chat.postMessage", false)).toBeNull();
	});
});
