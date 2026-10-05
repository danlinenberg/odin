import { describe, expect, it } from "bun:test";
import { slackThread, slackWebClientUrl } from "./in-app-browser";

describe("slackThread", () => {
	it("reads a reply's thread off its link", () => {
		expect(
			slackThread(
				"https://imagenai.slack.com/messages/C03E00FMZT4/p1789567345867699?thread_ts=1789548841.970539&cid=C03E00FMZT4",
			),
		).toEqual({
			workspace: "imagenai",
			channel: "C03E00FMZT4",
			threadTs: "1789548841.970539",
			replyTs: "1789567345.867699",
		});
	});

	it("takes a message without thread_ts as the head of its own thread", () => {
		expect(
			slackThread(
				"https://imagenai.slack.com/archives/D0ARNCW6DN1/p1790165128883119",
			),
		).toEqual({
			workspace: "imagenai",
			channel: "D0ARNCW6DN1",
			threadTs: "1790165128.883119",
			replyTs: "1790165128.883119",
		});
	});

	it("is null for a link that isn't a message", () => {
		for (const url of [
			"https://imagenai.slack.com/messages/C03E00FMZT4/",
			"https://app.slack.com/client/T01VC5US6L8/C03E00FMZT4",
			"https://imagenai.atlassian.net/browse/BUGT-1",
		]) {
			expect(slackThread(url)).toBeNull();
		}
	});
});

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
