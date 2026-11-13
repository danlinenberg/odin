import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { typedItem } from "renderer/routes/_authenticated/_odin/hooks/useAwayTasksSync";
import { AWAY_INBOX_PY } from "../../remote-host/away";
import { addedTasks, doneMarks } from "./inbox";
import { hostPhoneRouter, shell } from "./router";
import { hostPaths, tmux } from "./sessions";

const SESSION = "11111111-2222-3333-4444-555555555555";
let dir = "";
let home = "";
const night = () => join(dir, ".odin", "night");
const caller = () => hostPhoneRouter.createCaller({});
const killed: string[][] = [];
const started: string[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "odin-host-inbox-"));
	mkdirSync(night(), { recursive: true });
	home = hostPaths.home;
	hostPaths.home = dir;
	writeFileSync(
		join(night(), "away.json"),
		JSON.stringify({ until: Date.now() / 1000 + 3600, tasks: [] }),
	);
	killed.length = 0;
	started.length = 0;
	tmux.run = async (args) => {
		if (args[0] === "list-sessions") return `odin-${SESSION}\tclaude\n`;
		if (args[0] === "kill-session") killed.push(args);
		return "";
	};
	shell.startTask = async (key) => {
		started.push(key);
		return { code: 0, out: SESSION };
	};
});
afterEach(() => {
	hostPaths.home = home;
	rmSync(dir, { recursive: true, force: true });
});

describe("the phone with the Mac away: New task", () => {
	test("keeps it for the Mac, and Start starts it here", async () => {
		await caller().add({ text: "Fix the gate\nbefore Friday", start: false });
		const [task] = addedTasks();
		expect(task).toMatchObject({
			title: "Fix the gate",
			text: "Fix the gate\nbefore Friday",
		});
		expect(task.key).toMatch(/^task:[0-9a-f-]{36}$/);
		expect(started).toEqual([]);
		const answer = await caller().add({ text: "Ship it", start: true });
		expect(answer).toMatchObject({ paneId: SESSION });
		expect(started).toEqual([addedTasks()[1].key]);
	});

	test("refuses files, and a host the Mac left nothing on", async () => {
		await expect(
			caller().add({ text: "x", paths: [{ name: "a.png" }] }),
		).rejects.toThrow(/Files need your Mac/);
		rmSync(join(night(), "away.json"));
		await expect(caller().add({ text: "x" })).rejects.toThrow(
			/Tasks with the Mac closed is off/,
		);
		expect(addedTasks()).toEqual([]);
	});

	test("the Mac takes it in as a Tasks row with the same key", () => {
		const item = typedItem({
			key: "task:abc",
			title: "Fix the gate",
			text: "Fix the gate\nbefore Friday",
			at: 1,
		});
		expect(item).toMatchObject({ key: "task:abc", title: "Fix the gate" });
	});
});

describe("the phone with the Mac away: Done", () => {
	test("ends the session and keeps its task for the Mac to mark done", async () => {
		writeFileSync(
			join(night(), "ran.jsonl"),
			`${JSON.stringify({ key: "jira:A-1", sessionId: SESSION })}\n`,
		);
		await caller().done({ paneId: SESSION });
		expect(killed).toEqual([["kill-session", "-t", `odin-${SESSION}`]]);
		expect(doneMarks()).toMatchObject([
			{ key: "jira:A-1", sessionId: SESSION },
		]);
		// And the backlog leaves it out.
		const board = await caller().board();
		expect(board.backlog.map((row) => row.id)).not.toContain("jira:A-1");
	});
});

describe("the Mac reads and clears what the phone did", () => {
	const inbox = (...args: string[]) =>
		JSON.parse(
			spawnSync("python3", ["-I", "-c", AWAY_INBOX_PY, ...args], {
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
			})
				.stdout.toString()
				.trim(),
		);

	test("lists both, then drops what it took in", () => {
		writeFileSync(
			join(night(), "added.jsonl"),
			`${JSON.stringify({ key: "task:1", at: 10 })}\n${JSON.stringify({ key: "task:2", at: 20 })}\n`,
		);
		writeFileSync(
			join(night(), "done.jsonl"),
			`${JSON.stringify({ sessionId: "s", at: 15 })}\n`,
		);
		expect(inbox()).toEqual({
			added: [
				{ key: "task:1", at: 10 },
				{ key: "task:2", at: 20 },
			],
			done: [{ sessionId: "s", at: 15 }],
		});
		expect(inbox("15")).toEqual({
			added: [{ key: "task:2", at: 20 }],
			done: [],
		});
		expect(existsSync(join(night(), "done.jsonl"))).toBe(true);
		expect(readFileSync(join(night(), "done.jsonl"), "utf8")).toBe("");
	});
});
