import { describe, expect, it } from "bun:test";
import { slackTextToPlain } from "lib/trpc/routers/slack/reactions";
import { tidyTitle } from "./readable-title";

const readable = (raw: string) => tidyTitle(slackTextToPlain(raw));

describe("tidyTitle", () => {
	it("turns a Slack alert title into what a person reads", () => {
		expect(
			readable(
				"<!here> :rotating_light: _*SECURITY ALERT: Malicious Claude Code extension*_",
			),
		).toBe("@here 🚨 SECURITY ALERT: Malicious Claude Code extension");
	});

	it("keeps an unresolved mention as @id, without the brackets", () => {
		expect(readable("<@U08EJ28KM0V> Edited previews fail - wdyt?")).toBe(
			"@U08EJ28KM0V Edited previews fail - wdyt?",
		);
	});

	it("keeps underscores inside words", () => {
		expect(tidyTitle("fix edit_project_id in _culling_ path")).toBe(
			"fix edit_project_id in culling path",
		);
	});

	it("leaves a plain title alone", () => {
		expect(tidyTitle("CI Box")).toBe("CI Box");
	});
});
