import { describe, expect, it } from "bun:test";
import { slackThread } from "./board/brief";
import { buildThreadPrompt } from "./thread-prompt";

const THREAD =
	"https://imagenai.slack.com/archives/C0BA028MF7W/p1789357218234749";

describe("buildThreadPrompt", () => {
	it("quotes the message, so the session is about the ask and not the recipe", () => {
		const prompt = buildThreadPrompt(
			THREAD,
			"Hi good morning :sunny:",
			"Hi good morning :sunny:\nCan we stop charging RE users twice for an export?",
		);
		expect(prompt).toContain(
			"Can we stop charging RE users twice for an export?",
		);
	});

	it("keeps its own thread link first, above any link in the message", () => {
		const pasted =
			"https://imagenai.slack.com/archives/C0C1GB6AHCY/p1788966541529909";
		const prompt = buildThreadPrompt(THREAD, "see this", `see this ${pasted}`);
		// The board reads a session's thread off the first Slack link in the
		// transcript — a link someone pasted must never outrank ours.
		expect(slackThread([{ role: "user", text: prompt, at: null }])).toBe(
			THREAD,
		);
	});
});
