import { describe, expect, it } from "bun:test";
import { slackWebClientUrl } from "./in-app-browser";

describe("slackWebClientUrl", () => {
	it("sends a Slack archive link to the web client, thread and all", () => {
		expect(
			slackWebClientUrl(
				"https://imagenai.slack.com/archives/C03E00FMZT4/p1789567345867699?thread_ts=1789548841.970539&cid=C03E00FMZT4",
			),
		).toBe(
			"https://imagenai.slack.com/messages/C03E00FMZT4/p1789567345867699?thread_ts=1789548841.970539&cid=C03E00FMZT4",
		);
	});

	it("leaves every other link alone", () => {
		for (const url of [
			"https://app.slack.com/client/T01VC5US6L8/C03E00FMZT4",
			"https://github.com/org/repo/archives/main",
			"https://imagenai.atlassian.net/browse/BUGT-1",
		]) {
			expect(slackWebClientUrl(url)).toBe(url);
		}
	});
});
