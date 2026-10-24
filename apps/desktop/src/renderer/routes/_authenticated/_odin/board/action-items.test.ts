import { expect, test } from "bun:test";
import { noActionItems, runnableCommands } from "./action-items";

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
