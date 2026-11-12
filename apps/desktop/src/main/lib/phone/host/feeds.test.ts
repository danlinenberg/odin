import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeedCall } from "../../feeds";
import { NIGHT_RUNNER_PY } from "../../remote-host/night";
import { hostBoard, serviceCall } from "./feeds";
import { awayBacklog, hostPaths } from "./sessions";

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
let dir = "";
let home = "";
const night = () => join(dir, ".odin", "night");
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "odin-host-board-"));
	mkdirSync(night(), { recursive: true });
	writeFileSync(join(night(), "runner.py"), NIGHT_RUNNER_PY);
	home = hostPaths.home;
	hostPaths.home = dir;
});
afterEach(() => {
	hostPaths.home = home;
	rmSync(dir, { recursive: true, force: true });
});

const PANE = "0dinpane-0000-4000-8000-000000000000";
const sendList = () =>
	writeFileSync(
		join(night(), "away.json"),
		JSON.stringify({
			until: now() + 3600,
			tasks: [{ key: "task:1", title: "Mine", sessionId: "s1", script: "x" }],
			template: {
				prompt: "Task: __ODIN_NIGHT_TASK__\n\nmy rules",
				script: `claude --session-id ${PANE} "$(echo __ODIN_PROMPT_B64__ | base64 -d)"`,
			},
			feeds: {
				slackReaction: "eyes",
				jiraSiteUrl: null,
				notionDatabaseId: null,
			},
			done: {},
		}),
	);

/** The runner's `start <key>`, with the tmux launch swapped for writing its script out. */
function start(key: string) {
	const run = spawnSync(
		"python3",
		[
			"-I",
			"-c",
			[
				"import sys; sys.path.insert(0, sys.argv[1]); import runner as r",
				`r.read = lambda path: "MemTotal: 32000000 kB\\nMemAvailable: 30000000 kB\\n" if path.endswith("meminfo") else "1.0 1.0 1.0 1/1 1\\n"`,
				"def launch(task, row):\n    open(sys.argv[1] + '/launched.sh', 'w').write(task['script'])\n    r.record(row)",
				"r.launch = launch",
				"sys.exit(r.start_away(sys.argv[2]))",
			].join("\n"),
			night(),
			key,
		],
		{ env: { ...env, HOME: dir } },
	);
	return { code: run.status, out: run.stdout.toString().trim() };
}

describe("the host's own board: Start", () => {
	test("starts a row the host fetched, in the laptop's template, with only its text", () => {
		sendList();
		writeFileSync(
			join(night(), "board.json"),
			JSON.stringify([
				{
					key: "slack:C1:1.2",
					title: "Fix the gate",
					text: "Fix the gate\n\n$(rm -rf ~)",
				},
			]),
		);
		const { code, out } = start("slack:C1:1.2");
		expect(code).toBe(0);
		expect(out).toMatch(/^[0-9a-f-]{36}$/);
		const script = readFileSync(join(night(), "launched.sh"), "utf8");
		// The id is fresh, the text sits base64 in the script, never as shell.
		expect(script).toContain(`--session-id ${out}`);
		expect(script).not.toContain("rm -rf");
		const b64 = /echo (\S+) \| base64/.exec(script)?.[1] ?? "";
		expect(Buffer.from(b64, "base64").toString()).toBe(
			"Task: Fix the gate\n\n$(rm -rf ~)\n\nmy rules",
		);
		// A second tap opens the same session.
		expect(start("slack:C1:1.2")).toEqual({ code: 0, out });
	});

	test("starts nothing the host didn't fetch, nor without a template", () => {
		sendList();
		writeFileSync(join(night(), "board.json"), "[]");
		expect(start("slack:C9:9.9").code).toBe(4);
		writeFileSync(
			join(night(), "away.json"),
			JSON.stringify({ until: now() + 3600, tasks: [] }),
		);
		writeFileSync(
			join(night(), "board.json"),
			JSON.stringify([{ key: "jira:A-1", title: "A", text: "A" }]),
		);
		expect(start("jira:A-1").code).toBe(4);
	});

	test("the backlog lists the laptop's tasks, then the host's rows, less what started", () => {
		sendList();
		writeFileSync(
			join(night(), "ran.jsonl"),
			`${JSON.stringify({ key: "jira:A-1" })}\n`,
		);
		expect(
			awayBacklog(Date.now(), [
				{ key: "task:1", title: "Mine again" },
				{ key: "jira:A-1", title: "Started" },
				{ key: "jira:A-2", title: "Open" },
			]),
		).toEqual([
			{ id: "task:1", title: "Mine", started: false },
			{ id: "jira:A-2", title: "Open", started: false },
		]);
	});
});

test("a task typed on the phone starts before the board's next fetch", () => {
	sendList();
	writeFileSync(join(night(), "board.json"), "[]");
	writeFileSync(
		join(night(), "added.jsonl"),
		`${JSON.stringify({ key: "task:t1", title: "Ship it", text: "Ship it\ntoday", at: 1 })}\n`,
	);
	const { code } = start("task:t1");
	expect(code).toBe(0);
	const script = readFileSync(join(night(), "launched.sh"), "utf8");
	const b64 = /echo (\S+) \| base64/.exec(script)?.[1] ?? "";
	expect(Buffer.from(b64, "base64").toString()).toBe(
		"Task: Ship it\ntoday\n\nmy rules",
	);
});

describe("the host's own board: fetch", () => {
	test("reads the service's answer as the API's", async () => {
		const call = serviceCall("slack", async (form) =>
			form.get("path") === "auth.test"
				? 'HTTP 401\n{"ok":false}\n'
				: "slack isn't on this host.\n",
		);
		expect((await call("auth.test")).status).toBe(401);
		expect((await call("reactions.list")).status).toBe(503);
	});

	test("lists my queued Slack messages, less what is done on the laptop", async () => {
		const message = (ts: string, text: string) => ({
			type: "message",
			channel: "C1",
			message: {
				ts,
				user: "U2",
				text,
				permalink: `https://example.slack.com/p${ts}`,
				reactions: [{ name: "eyes", users: ["U1"] }],
			},
		});
		const fake =
			(service: string): FeedCall =>
			async (path) =>
				new Response(
					service !== "slack"
						? "off"
						: path === "auth.test"
							? JSON.stringify({ ok: true, user_id: "U1" })
							: JSON.stringify({
									ok: true,
									items: [
										message("1.1", "Ship it\nplease"),
										message("2.2", "Old"),
									],
								}),
					{ status: service === "slack" ? 200 : 503 },
				);
		const items = await hostBoard(
			{ slackReaction: "eyes", jiraSiteUrl: null, notionDatabaseId: null },
			{ "slack:C1:2.2": { at: Date.now(), url: null } },
			fake as typeof serviceCall,
		);
		expect(items.map((item) => [item.key, item.title])).toEqual([
			["slack:C1:1.1", "Ship it"],
		]);
	});
});
