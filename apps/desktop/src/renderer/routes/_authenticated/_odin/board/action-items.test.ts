import { describe, expect, test } from "bun:test";
import {
	bangCommandNotes,
	bangCommands,
	describeCommand,
	downloadPath,
	isMoveHereItem,
	itemPullRequests,
	itemSnippets,
	localRunMessage,
	noActionItems,
	phoneCommands,
	placeCommands,
	runnableCommands,
	settledItem,
	viewTarget,
	withoutLocalBlocks,
} from "./action-items";
import { actionItemEntries } from "./brief";

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

test("a command with no note above it still says what it does", () => {
	expect(
		describeCommand(
			"cd ~/dev && rm -rf acme/editing-service/venv acme/bifrost/src-tauri/target",
		),
	).toBe("Delete 2 files or folders");
	expect(describeCommand("rm -rf ~/dev/acme/old/venv")).toBe("Delete venv");
	expect(describeCommand("df -h /System/Volumes/Data | tail -1")).toBe(
		"Show the free space left on the disk",
	);
	expect(
		describeCommand("cd ~/dev && du -shc a b c 2>/dev/null | tail -1"),
	).toBe("Show the disk size of 4 folders");
	expect(describeCommand("aws sso login --profile dev")).toBe(
		"Run aws sso login",
	);
	expect(describeCommand("curl -s https://api.example.com/v1/x")).toBe(
		"Call api.example.com",
	);
	expect(describeCommand("AWS_PROFILE=dev ./scripts/deploy.sh prod")).toBe(
		"Run deploy.sh prod",
	);
});

test("the phone puts each `!` command under the item it was written under", () => {
	const actions = [
		"1. Smoke-test the CLI on your Mac (you only)",
		"   Download the CLI:",
		"   ```",
		"   !local gh api repos/x/y/contents/z --jq .content > /tmp/z.py",
		"   ```",
		"   Deploy your env:",
		"   ```",
		"   !local python3 -I /tmp/z.py up",
		"   ```",
		"2. Merge the PR: https://github.com/x/y/pull/1",
		"3. Ask Alexander for a cost estimate (you only)",
	].join("\n");
	const commands = [
		"local gh api repos/x/y/contents/z --jq .content > /tmp/z.py",
		"local python3 -I /tmp/z.py up",
	];
	expect(placeCommands(actions, commands)).toEqual({
		under: [commands, [], []],
		foot: [],
	});
});

test("a command no item claims goes to the card's foot", () => {
	expect(placeCommands("1. Pick a name [A | B]", ["df -h"])).toEqual({
		under: [[]],
		foot: ["df -h"],
	});
});

test("an item keeps its ```sql block as code; its `!` block stays a Run button", () => {
	const [first, second] = actionItemEntries(
		[
			"1. Run this lookup in your DB client (you only)",
			"    ```sql",
			"    SELECT id",
			"    FROM users;",
			"    ```",
			"2. Check the disk",
			"   ```",
			"   ! df -h",
			"   ```",
		].join("\n"),
	);
	expect(itemSnippets(first?.fences ?? [])).toEqual([
		"```sql\nSELECT id\nFROM users;\n```",
	]);
	expect(itemSnippets(second?.fences ?? [])).toEqual([]);
});

test("an item asking to move the session to my computer gets the Move button", () => {
	expect(
		isMoveHereItem("Move this session to my computer to use TaxJar there"),
	).toBe(true);
	expect(isMoveHereItem("**Move the session to this Mac**")).toBe(true);
	expect(isMoveHereItem("Move the files to my computer's Downloads")).toBe(
		false,
	);
	expect(isMoveHereItem("Merge the PR")).toBe(false);
	expect(isMoveHereItem("Remove the cache on my computer")).toBe(false);
	expect(isMoveHereItem("Move it to the remote host")).toBe(false);
});

const PR = "https://github.com/acme/internal-claude/pull/1091";
const OTHER = "https://github.com/acme/odin/pull/7";

test("an item's PR links are found once each, inside markdown links too", () => {
	expect(itemPullRequests(`Merge [PR #1091](${PR}): ${PR}`)).toEqual([PR]);
	expect(itemPullRequests("Tell me the export format [CSV | page]")).toEqual(
		[],
	);
});

test("a merge item for a PR you already merged reads as done", () => {
	expect(
		settledItem(`Merge PR #1091: ${PR}`, { [PR]: { state: "MERGED" } }),
	).toBe("MERGED");
	expect(
		settledItem(`Merge PR #1091: ${PR}`, { [PR]: { state: "CLOSED" } }),
	).toBe("CLOSED");
});

test("an open, unknown or partly open PR keeps the item live", () => {
	expect(settledItem(`Merge ${PR}`, { [PR]: { state: "OPEN" } })).toBeNull();
	expect(settledItem(`Merge ${PR}`, {})).toBeNull();
	expect(settledItem(`Merge ${PR}`, undefined)).toBeNull();
	expect(
		settledItem(`Merge ${PR} and ${OTHER}`, {
			[PR]: { state: "MERGED" },
			[OTHER]: { state: "OPEN" },
		}),
	).toBeNull();
	expect(
		settledItem("Tell me whether to go on", { [PR]: { state: "MERGED" } }),
	).toBeNull();
});

test("an item with work left after the merge stays live", () => {
	expect(
		settledItem(`Revert PR #1091: ${PR}`, { [PR]: { state: "MERGED" } }),
	).toBeNull();
	expect(
		settledItem(`Review and approve ${PR}`, { [PR]: { state: "MERGED" } }),
	).toBe("MERGED");
});

test("downloadPath reads a !download block's host path, quotes dropped", () => {
	expect(downloadPath("download /home/me/out/users.csv")).toBe(
		"/home/me/out/users.csv",
	);
	expect(downloadPath('download "/tmp/a b/report.csv"')).toBe(
		"/tmp/a b/report.csv",
	);
	expect(downloadPath("local open ~/Downloads")).toBeNull();
	expect(downloadPath("downloads-cleanup.sh")).toBeNull();
	expect(downloadPath("download")).toBeNull();
});

test("runnableCommands leaves !download out: the phone can't take the file", () => {
	const reply =
		"Grab it:\n\n```\n!download /tmp/users.csv\n```\n\nThen:\n\n```\n!ls /tmp\n```";
	expect(runnableCommands([{ role: "assistant", text: reply }])).toEqual([
		"ls /tmp",
	]);
});

test("a ```! block with a # label line runs, and the label names its button", () => {
	const text =
		"Start them:\n\n```!\n# Start the replays in the background\ncd /x && nohup run.py &\n```";
	expect(bangCommands(text)).toEqual(["cd /x && nohup run.py &"]);
	expect(bangCommandNotes(text)).toEqual({
		"cd /x && nohup run.py &": "Start them:",
	});
	expect(bangCommandNotes("```!\n# Start the replays\nrun.py\n```")).toEqual({
		"run.py": "Start the replays",
	});
});

test("a ```! block that already starts with ! is read once", () => {
	expect(bangCommands("```!\n! git status\n```")).toEqual(["git status"]);
});

test("a block under a list item runs without the item's indent, so a heredoc still ends", () => {
	const text = [
		"1. Do it:",
		"   ```",
		"   !local x=$(cat <<'EOF'",
		"   hello",
		"     indented on purpose",
		"   EOF",
		"   ); echo $x",
		"   ```",
	].join("\n");
	expect(bangCommands(text)).toEqual([
		"local x=$(cat <<'EOF'\nhello\n  indented on purpose\nEOF\n); echo $x",
	]);
	expect(
		bangCommands(
			"1. Label\n   ```!\n   # Says hi\n   echo a\n   echo b\n   ```",
		),
	).toEqual(["echo a\necho b"]);
});

test("a block at the margin keeps its lines as written", () => {
	expect(bangCommands("```\n!for f in *; do\n  echo $f\ndone\n```")).toEqual([
		"for f in *; do\n  echo $f\ndone",
	]);
});

test("other blocks stay code: a ```bash block and an empty ```! block run nothing", () => {
	expect(bangCommands("```bash\nls\n```\n```!\n# only a label\n```")).toEqual(
		[],
	);
});

test("a !view block names the host screen's port and password; anything else is not one", () => {
	expect(viewTarget("view 37166 iydAXuDu")).toEqual({
		port: 37166,
		password: "iydAXuDu",
	});
	expect(viewTarget("view 99999 x")).toBeNull();
	expect(viewTarget("view 37166")).toBeNull();
	expect(viewTarget("view port pw")).toBeNull();
	expect(viewTarget("ls view 1 2")).toBeNull();
});

test("the phone leaves out !view: the app shows in the drawer on the computer", () => {
	expect(
		phoneCommands("```\n!view 37166 pw\n```\n```\n!git status\n```"),
	).toEqual(["git status"]);
});

describe("withoutLocalBlocks", () => {
	test("swaps a !local block for a note and keeps other blocks", () => {
		const text =
			"Run it:\n\n```text\n!local\ncd ~/odin && scripts/release.sh\n```\n\nThen:\n\n```\n! ls\n```";
		const out = withoutLocalBlocks(text);
		expect(out).not.toContain("release.sh");
		expect(out).toContain("Runs on your computer, not on the remote host");
		expect(out).toContain("! ls");
	});
});
