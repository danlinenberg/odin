import { expect, test } from "bun:test";
import {
	modelFlag,
	pickClaudeCommand,
	remoteControlFlag,
} from "./claude-command";

test("pickClaudeCommand", () => {
	expect(pickClaudeCommand([], "")).toBe("claude");
	expect(pickClaudeCommand(["claude-me", "claude-work"], "")).toBe("claude-me");
	expect(pickClaudeCommand(["claude-me", "claude-work"], "claude-work")).toBe(
		"claude-work",
	);
	// A removed pick falls back to the first one left.
	expect(pickClaudeCommand(["claude-me"], "claude-work")).toBe("claude-me");
});

test("modelFlag", () => {
	expect(modelFlag("")).toBe("");
	expect(modelFlag("opus")).toBe(" --model opus");
	expect(modelFlag("opus; rm -rf ~")).toBe("");
});

test("remoteControlFlag", () => {
	expect(remoteControlFlag("Fix it", false)).toBe("");
	expect(remoteControlFlag("Fix  dan's\nbug", true)).toBe(
		` --remote-control 'Fix dan'\\''s bug'`,
	);
	expect(remoteControlFlag("  ", true)).toBe(" --remote-control");
});
