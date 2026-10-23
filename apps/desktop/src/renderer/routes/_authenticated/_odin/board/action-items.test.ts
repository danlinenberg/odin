import { expect, test } from "bun:test";
import { runnableCommands } from "./action-items";

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
