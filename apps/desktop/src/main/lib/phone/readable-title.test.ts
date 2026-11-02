import { describe, expect, it } from "bun:test";
import { slackTextToPlain } from "lib/trpc/routers/slack/reactions";
import { readableTitle, tidyTitle } from "./readable-title";

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

describe("readableTitle", () => {
	it("uses Slack's names when they come in time", async () => {
		const names = async (raw: string) => raw.replace("<@U1>", "@Dan");
		expect(await readableTitle("<@U1> look", names)).toBe("@Dan look");
	});

	it("doesn't wait on a slow Slack: the title reads as @id", async () => {
		const stuck = () => new Promise<string>(() => {});
		const started = Date.now();
		expect(await readableTitle("<@U1> look", stuck, 20)).toBe("@U1 look");
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("falls back to plain text when Slack fails", async () => {
		const failed = () => Promise.reject(new Error("rate limited"));
		expect(await readableTitle("<!here> :pray: hi", failed)).toBe(
			"@here 🙏 hi",
		);
	});
});
