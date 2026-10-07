import { expect, test } from "bun:test";
import { pickClaudeCommand } from "./claude-command";

test("pickClaudeCommand", () => {
	expect(pickClaudeCommand([], "")).toBe("claude");
	expect(pickClaudeCommand(["claude-me", "claude-work"], "")).toBe("claude-me");
	expect(pickClaudeCommand(["claude-me", "claude-work"], "claude-work")).toBe(
		"claude-work",
	);
	// A removed pick falls back to the first one left.
	expect(pickClaudeCommand(["claude-me"], "claude-work")).toBe("claude-me");
});
