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
import { awayBacklog, hostPaths } from "main/lib/phone/host/sessions";
import { adoptable } from "renderer/routes/_authenticated/_odin/hooks/useAwayTasksSync";
import { clearAwayScript } from "./away";
import { NIGHT_RUNNER_PY } from "./night";

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
let dir = "";
const night = () => join(dir, ".odin", "night");
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "odin-away-"));
	mkdirSync(night(), { recursive: true });
	writeFileSync(join(night(), "runner.py"), NIGHT_RUNNER_PY);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sendList = (until = now() + 3600) =>
	writeFileSync(
		join(night(), "away.json"),
		JSON.stringify({
			until,
			tasks: [
				{ key: "task:1", title: "Fix the gate", sessionId: "s1", script: "x" },
				{ key: "task:2", title: "Ship it", sessionId: "s2", script: "x" },
			],
		}),
	);

/** The runner's `start <key>`, with the tmux launch swapped for its ledger write. */
function start(key: string, memAvailableKb = 30_000_000) {
	const run = spawnSync(
		"python3",
		[
			"-I",
			"-c",
			[
				"import sys; sys.path.insert(0, sys.argv[1]); import runner as r",
				`r.read = lambda path: "MemTotal: 32000000 kB\\nMemAvailable: ${memAvailableKb} kB\\n" if path.endswith("meminfo") else "1.0 1.0 1.0 1/1 1\\n"`,
				"r.launch = lambda task, row: r.record(row)",
				"sys.exit(r.start_away(sys.argv[2]))",
			].join("\n"),
			night(),
			key,
		],
		{ env: { ...env, HOME: dir } },
	);
	return { code: run.status, out: run.stdout.toString().trim() };
}

const ledger = () =>
	readFileSync(join(night(), "ran.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));

describe("Tasks with the Mac closed: the runner's start", () => {
	test("starts a task the laptop sent, marked as the phone's", () => {
		sendList();
		expect(start("task:1")).toEqual({ code: 0, out: "s1" });
		expect(ledger()).toMatchObject([
			{ key: "task:1", sessionId: "s1", away: true },
		]);
	});

	test("a second tap opens the same session and starts nothing more", () => {
		sendList();
		start("task:1");
		expect(start("task:1")).toEqual({ code: 0, out: "s1" });
		expect(ledger()).toHaveLength(1);
	});

	test("starts nothing the laptop didn't send, or after the list expired", () => {
		sendList();
		expect(start("task:9; rm -rf ~").code).toBe(4);
		sendList(now() - 1);
		expect(start("task:1").code).toBe(4);
	});

	test("holds while the host is low on memory", () => {
		sendList();
		expect(start("task:1", 1_000_000)).toEqual({
			code: 6,
			out: "this host has 1.0 GB free",
		});
	});
});

describe("Tasks with the Mac closed: the host's backlog", () => {
	test("lists what the laptop sent, less what already started", () => {
		const home = hostPaths.home;
		hostPaths.home = dir;
		try {
			sendList();
			start("task:1");
			expect(awayBacklog()).toEqual([
				{ id: "task:2", title: "Ship it", started: false },
			]);
			sendList(now() - 1);
			expect(awayBacklog()).toEqual([]);
		} finally {
			hostPaths.home = home;
		}
	});

	test("switching it off deletes the list, the runner and unneeded secrets", () => {
		sendList();
		writeFileSync(join(night(), "env"), "K='v'");
		spawnSync("bash", ["-c", clearAwayScript], { env: { ...env, HOME: dir } });
		expect(() => readFileSync(join(night(), "away.json"))).toThrow();
		expect(() => readFileSync(join(night(), "runner.py"))).toThrow();
		expect(() => readFileSync(join(night(), "env"))).toThrow();
	});
});

describe("Tasks with the Mac closed: the board adopts", () => {
	const at = Date.now() / 1000;
	test("only the phone's starts that aren't on the board", () => {
		expect(adoptable({ away: true, sessionId: "s1", at }, new Set())).toBe(
			true,
		);
		expect(adoptable({ sessionId: "s1", at }, new Set())).toBe(false);
		expect(
			adoptable({ away: true, sessionId: "s1", at }, new Set(["s1"])),
		).toBe(false);
		expect(
			adoptable(
				{ away: true, sessionId: "s1", at: at - 30 * 86_400 },
				new Set(),
			),
		).toBe(false);
	});
});
