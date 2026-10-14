import { describe, expect, it } from "bun:test";
import { promptText, voiceState } from "./voice";

const RULE = "─".repeat(60);
const screen = (prompt: string, footer: string) => `
 ▐▛███▛█   Claude Code v2.1.294
${RULE}
❯ ${prompt}
${RULE}
  ⏵⏵ auto mode on (shift+tab to cycle)
${footer}`;

describe("promptText", () => {
	it("reads the input box and drops the level meter", () => {
		const s = screen("Please add a test for the login page.▄", "listening…");
		expect(promptText(s)).toBe("Please add a test for the login page.");
		expect(voiceState(s)).toBe("recording");
	});

	it("joins a wrapped prompt", () => {
		const s = `${RULE}\n❯ first half of a long\n  dictated message\n${RULE}\n`;
		expect(promptText(s)).toBe("first half of a long dictated message");
	});

	it("skips a menu cursor that is not in the input box", () => {
		const s = `  ❯ 1. Yes\n    2. No\n${RULE}\n❯ hi\n${RULE}\n`;
		expect(promptText(s)).toBe("hi");
		expect(promptText("  ❯ 1. Yes\n    2. No\n")).toBeNull();
	});
});

describe("voiceState", () => {
	it("tells recording, processing and idle apart", () => {
		expect(voiceState(screen("", "keep holding…"))).toBe("recording");
		expect(voiceState(screen("", "Voice: processing…"))).toBe("processing");
		expect(voiceState(screen('Try "fix lint"', "? for shortcuts"))).toBe(
			"idle",
		);
	});
});

describe("voice state reads only the input box", () => {
	it("ignores voice words quoted in the conversation above", () => {
		const talk = `⏺ It shows "Voice: processing…" and then "keep holding…".\n${screen("", "? for shortcuts")}`;
		expect(voiceState(talk)).toBe("idle");
		expect(
			voiceState(`⏺ listening… is quoted\n${screen("", "listening…")}`),
		).toBe("recording");
	});

	it("reads Claude's grey hint as an empty box", () => {
		expect(promptText(screen('Try "fix lint errors"', ""))).toBe("");
		expect(promptText(screen("Try the other one", ""))).toBe(
			"Try the other one",
		);
	});
});
