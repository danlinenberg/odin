import { expect, test } from "bun:test";
import {
	localRunMessage,
	noActionItems,
	runnableCommands,
} from "./action-items";

const reply = (text: string) => ({ role: "assistant", text });
const block = (command: string) => `\`\`\`\n! ${command}\n\`\`\``;

test("the phone runs only the `!` commands of the latest reply that has any", () => {
	expect(
		runnableCommands([
			reply(`Old:\n${block("rm -rf old")}`),
			{ role: "user", text: "ok" },
			reply(`Preview:\n${block("git status")}\n\n${block("local open ~/x")}`),
			reply("Thinking it over."),
		]),
	).toEqual(["git status", "local open ~/x"]);
});

test("no reply with a `!` block: nothing runs", () => {
	expect(runnableCommands([reply("```\nls\n```")])).toEqual([]);
	expect(runnableCommands([])).toEqual([]);
});

test("noActionItems: only a block that says none", () => {
	expect(noActionItems("none - shipped.")).toBe(true);
	expect(noActionItems("1. None right now")).toBe(true);
	expect(noActionItems("1. Merge PR #12")).toBe(false);
	expect(noActionItems("Nonetheless:\n1. Merge PR #12")).toBe(false);
});

test("a !local run goes back to Claude fenced past its own backticks", () => {
	expect(localRunMessage("ls", { exitCode: 0, output: "a\nb" })).toBe(
		"I ran this on my computer (exit code 0):\n\n```\n$ ls\na\nb\n```",
	);
	expect(
		localRunMessage("cat x.md", { exitCode: 1, output: "```js\n```" }),
	).toBe(
		"I ran this on my computer (exit code 1):\n\n````\n$ cat x.md\n```js\n```\n````",
	);
	expect(localRunMessage("true", { exitCode: 0, output: "" })).toContain(
		"(no output)",
	);
});
