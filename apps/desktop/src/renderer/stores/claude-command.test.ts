import { expect, test } from "bun:test";
import {
	claudeLaunch,
	modelFlag,
	pickClaudeCommand,
	remoteControlEnv,
	remoteControlFlag,
	remoteControlOn,
	useClaudeCommand,
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

test("remoteControlFlag: always named [Odin] <task>", () => {
	expect(remoteControlFlag("Fix it", false)).toBe("");
	expect(remoteControlFlag("Fix  dan's\nbug", true)).toBe(
		` --remote-control '[Odin] Fix dan'\\''s bug'`,
	);
	expect(remoteControlFlag("  ", true)).toBe(" --remote-control '[Odin]'");
});

test("remoteControlEnv", () => {
	expect(remoteControlEnv(false)).toBe("");
	expect(remoteControlEnv(true)).toBe(
		"unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && ",
	);
});

test("claudeLaunch: a resume gets Remote Control like a new session", () => {
	useClaudeCommand.setState({ commands: [], model: "", remoteControl: "all" });
	expect(claudeLaunch("Fix it", "--resume abc")).toBe(
		"unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && claude --dangerously-skip-permissions --remote-control '[Odin] Fix it' --resume abc",
	);
	useClaudeCommand.setState({ remoteControl: "off" });
	expect(claudeLaunch("Fix it", "--resume abc")).toBe(
		"claude --dangerously-skip-permissions --resume abc",
	);
});

test("remoteControlOn: selected sessions only", () => {
	useClaudeCommand.setState({ remoteControl: "selected", remotePanes: [] });
	expect(remoteControlOn("p1")).toBe(false);
	useClaudeCommand.getState().toggleRemotePane("p1");
	expect(remoteControlOn("p1")).toBe(true);
	expect(remoteControlOn("p2")).toBe(false);
	expect(remoteControlOn()).toBe(false);
	expect(claudeLaunch("Fix it", "--resume abc", "p2")).toBe(
		"unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && claude --dangerously-skip-permissions --resume abc",
	);
	useClaudeCommand.getState().toggleRemotePane("p1");
	expect(remoteControlOn("p1")).toBe(false);
	useClaudeCommand.setState({ remoteControl: "off" });
});

test("recent repos: newest first, no repeats, at most five", () => {
	const { addRecentRepo } = useClaudeCommand.getState();
	useClaudeCommand.setState({ recentRepos: [] });
	for (const repo of ["/a", "/b", "/c", "/d", "/e", "/f", "/b"])
		addRecentRepo(repo);
	expect(useClaudeCommand.getState().recentRepos).toEqual([
		"/b",
		"/f",
		"/e",
		"/d",
		"/c",
	]);
});
