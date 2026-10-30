import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
import { MIN_HOST_FREE_MEMORY_SHARE } from "shared/launch-gate";
import {
	NIGHT_PANE_PLACEHOLDER,
	NIGHT_PROMPT_B64_PLACEHOLDER,
	NIGHT_RUNNER_PY,
	NIGHT_TASK_PLACEHOLDER,
	parseNightRead,
	READ_NIGHT_PY,
} from "./night";

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

/** The runner's `hold_reason`, run by python3 as it is on the host. */
function holdReason(
	meminfo: string,
	loadavg: string,
	cores: number | null,
): string | null {
	const dir = mkdtempSync(join(tmpdir(), "odin-night-"));
	try {
		writeFileSync(join(dir, "night_runner.py"), NIGHT_RUNNER_PY);
		const out = execFileSync(
			"python3",
			[
				"-I",
				"-c",
				"import json, sys; sys.path.insert(0, sys.argv[1]); import night_runner; print(json.dumps(night_runner.hold_reason(*json.loads(sys.argv[2]))))",
				dir,
				JSON.stringify([meminfo, loadavg, cores]),
			],
			{ env: { ...env, HOME: dir } },
		).toString();
		return JSON.parse(out) as string | null;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const meminfo = (availableKb: number) =>
	`MemTotal:       32000000 kB\nMemFree:         1000000 kB\nMemAvailable:   ${availableKb} kB\nBuffers:          100000 kB\n`;
const loadavg = (load1: number) =>
	`${load1.toFixed(2)} 0.50 0.20 1/400 12345\n`;

describe("the Night Agent runner on the host", () => {
	test("holds the next session while the host is low on memory", () => {
		expect(holdReason(meminfo(3_252_224), loadavg(1), 8)).toBe(
			"has 3.1 GB free",
		);
	});

	test("holds the next session while the host is busy", () => {
		expect(holdReason(meminfo(20_000_000), loadavg(9.21), 8)).toBe(
			"is busy (load 9.2 on 8 cores)",
		);
	});

	test("starts the next session on a quiet host", () => {
		expect(holdReason(meminfo(20_000_000), loadavg(2), 8)).toBeNull();
	});

	test("starts the next session when the host's numbers can't be read", () => {
		expect(holdReason("", "", null)).toBeNull();
		expect(holdReason("MemTotal: what\n", "high\n", 8)).toBeNull();
	});

	test("holds at the same share of free memory the Mac holds a launch at", () => {
		expect(NIGHT_RUNNER_PY).toContain(
			`MIN_FREE_SHARE = ${MIN_HOST_FREE_MEMORY_SHARE}`,
		);
	});

	test("with a plan and a host short of memory, it holds the task and starts nothing", () => {
		const dir = mkdtempSync(join(tmpdir(), "odin-night-"));
		try {
			writeFileSync(join(dir, "night_runner.py"), NIGHT_RUNNER_PY);
			const now = Math.floor(Date.now() / 1000);
			writeFileSync(
				join(dir, "plan.json"),
				JSON.stringify({
					id: "p1",
					from: now - 60,
					to: now + 3600,
					cap: 8,
					tasks: [
						{
							key: "task:1",
							title: "Fix the gate",
							sessionId: "s1",
							script: "echo hi",
						},
					],
				}),
			);
			const out = execFileSync(
				"python3",
				[
					"-I",
					"-c",
					[
						"import sys; sys.path.insert(0, sys.argv[1]); import night_runner as r",
						'r.PLAN, r.STATE = sys.argv[1] + "/plan.json", sys.argv[1] + "/state.json"',
						'r.read = lambda path: "MemTotal: 32000000 kB\\nMemAvailable: 1000000 kB\\n" if path.endswith("meminfo") else "1.0 1.0 1.0 1/1 1\\n"',
						"r.main()",
					].join("\n"),
					dir,
				],
				{ env: { ...env, HOME: dir } },
			).toString();
			expect(out).toBe("holding Fix the gate: this host has 1.0 GB free\n");
			expect(existsSync(join(dir, "state.json"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("run as a script with no plan, it starts nothing and exits clean", () => {
		const dir = mkdtempSync(join(tmpdir(), "odin-night-"));
		try {
			const file = join(dir, "night-runner.py");
			writeFileSync(file, NIGHT_RUNNER_PY);
			const out = execFileSync("python3", ["-I", file], {
				env: { ...env, HOME: dir },
			}).toString();
			expect(out).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a window that opens with last night's plan is recorded once as missed", () => {
		const dir = mkdtempSync(join(tmpdir(), "odin-night-"));
		try {
			writeFileSync(join(dir, "night_runner.py"), NIGHT_RUNNER_PY);
			const now = Math.floor(Date.now() / 1000);
			// Last night's window opened a day and ten minutes ago, for an hour.
			const from = now - 86_400 - 600;
			writeFileSync(
				join(dir, "plan.json"),
				JSON.stringify({ id: "p1", from, to: from + 3600, cap: 1, tasks: [] }),
			);
			const run = () =>
				execFileSync(
					"python3",
					[
						"-I",
						"-c",
						[
							"import sys; sys.path.insert(0, sys.argv[1]); import night_runner as r",
							'r.PLAN, r.STATE, r.MISSED = [sys.argv[1] + "/" + n for n in ("plan.json", "state.json", "missed.json")]',
							"r.main()",
						].join("\n"),
						dir,
					],
					{ env: { ...env, HOME: dir } },
				).toString();
			expect(run()).toContain("no plan for tonight");
			expect(run()).toBe("");
			const missed = JSON.parse(
				readFileSync(join(dir, "missed.json"), "utf8"),
			) as { night: number }[];
			expect(missed.map((m) => m.night)).toEqual([from + 86_400]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("outside any window, or before the plan's night, nothing is missed", () => {
		const dir = mkdtempSync(join(tmpdir(), "odin-night-"));
		try {
			writeFileSync(join(dir, "night_runner.py"), NIGHT_RUNNER_PY);
			const missed = (from: number, to: number, now: number) =>
				execFileSync(
					"python3",
					[
						"-I",
						"-c",
						"import json, sys; sys.path.insert(0, sys.argv[1]); import night_runner as r; print(json.dumps(r.missed_night(json.loads(sys.argv[2]), float(sys.argv[3]))))",
						dir,
						JSON.stringify({ from, to }),
						String(now),
					],
					{ env: { ...env, HOME: dir } },
				)
					.toString()
					.trim();
			const from = 1_000_000;
			// Tonight's plan, before and after its window.
			expect(missed(from, from + 3600, from - 60)).toBe("null");
			expect(missed(from, from + 3600, from + 7200)).toBe("null");
			// Two nights on, in the window and between windows.
			expect(missed(from, from + 3600, from + 2 * 86_400 + 60)).toBe(
				String(from + 2 * 86_400),
			);
			expect(missed(from, from + 3600, from + 2 * 86_400 + 7200)).toBe("null");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the laptop's read returns what the host started, its plan's night and the missed windows", () => {
		const dir = mkdtempSync(join(tmpdir(), "odin-night-"));
		try {
			const night = join(dir, ".odin", "night");
			mkdirSync(night, { recursive: true });
			const read = () =>
				parseNightRead(
					execFileSync("python3", ["-I", "-c", READ_NIGHT_PY], {
						env: { ...env, HOME: dir },
					}).toString(),
				);
			expect(read()).toEqual({ started: [], planFrom: null, missed: [] });
			writeFileSync(join(night, "plan.json"), JSON.stringify({ from: 5 }));
			writeFileSync(
				join(night, "state.json"),
				JSON.stringify({
					started: [{ key: "k", title: "t", sessionId: "s", at: 6 }],
				}),
			);
			writeFileSync(
				join(night, "missed.json"),
				JSON.stringify([{ night: 3, at: 4 }]),
			);
			expect(read()).toEqual({
				started: [{ key: "k", title: "t", sessionId: "s", at: 6 }],
				planFrom: 5,
				missed: [{ night: 3, at: 4 }],
			});
			// Once there is a ledger, it is the record: every night, not just tonight.
			writeFileSync(
				join(night, "ran.jsonl"),
				`${JSON.stringify({ key: "a", title: "A", sessionId: "s1", at: 1 })}\n${JSON.stringify({ key: "b", title: "B", sessionId: "s2", at: 2, url: "u", picked: true })}\n{"key": "c`,
			);
			expect(read().started.map((r) => r.key)).toEqual(["a", "b"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the Night Agent runner across nights", () => {
	const N0 = 1_793_052_000;
	const DAY = 86_400;

	/** A host in a folder: the runner, a tmux that only records, and a quiet machine. */
	function host() {
		const dir = mkdtempSync(join(tmpdir(), "odin-night-"));
		const night = join(dir, ".odin", "night");
		mkdirSync(join(night, "stopped"), { recursive: true });
		mkdirSync(join(dir, "bin"));
		mkdirSync(join(dir, "alive"));
		writeFileSync(join(dir, "night_runner.py"), NIGHT_RUNNER_PY);
		writeFileSync(join(night, "env"), "");
		writeFileSync(
			join(dir, "bin", "tmux"),
			`#!/bin/sh\ncase "$1" in\n  has-session) [ -e "${dir}/alive/$3" ] ;;\n  new-session) touch "${dir}/alive/$4" ;;\nesac\n`,
			{ mode: 0o755 },
		);
		const plan = (
			keys: string[],
			extra: Record<string, unknown> = {},
			nights = 3,
		) =>
			writeFileSync(
				join(night, "plan.json"),
				JSON.stringify({
					id: "p1",
					from: N0,
					to: N0 + 6 * 3600,
					cap: 2,
					tasks: keys.map((key) => ({
						key,
						title: key,
						sessionId: `s-${key.replaceAll(":", "_")}`,
						script: "true",
					})),
					nights: Array.from({ length: nights }, (_, i) => ({
						from: N0 + i * DAY,
						to: N0 + i * DAY + 6 * 3600,
					})),
					until: N0 + 10 * DAY,
					...extra,
				}),
			);
		/** One tick at `now`; `setup` is Python run first, with the runner as `r`. */
		const tick = (now: number, setup = "") =>
			execFileSync(
				"python3",
				[
					"-I",
					"-c",
					[
						"import sys, types; sys.path.insert(0, sys.argv[1]); import night_runner as r",
						`r.time = types.SimpleNamespace(time=lambda: ${now})`,
						'r.read = lambda path: "MemTotal: 32000000 kB\\nMemAvailable: 30000000 kB\\n" if path.endswith("meminfo") else "0.1 0.1 0.1 1/1 1\\n"',
						setup,
						"r.main()",
					].join("\n"),
					dir,
				],
				{ env: { PATH: `${join(dir, "bin")}:${env.PATH}`, HOME: dir } },
			).toString();
		const finish = () => {
			rmSync(join(dir, "alive"), { recursive: true });
			mkdirSync(join(dir, "alive"));
		};
		const ledger = () =>
			existsSync(join(night, "ran.jsonl"))
				? readFileSync(join(night, "ran.jsonl"), "utf8")
						.trim()
						.split("\n")
						.flatMap((line) => {
							try {
								return [(JSON.parse(line) as { key: string }).key];
							} catch {
								return [];
							}
						})
				: [];
		const done = () => rmSync(dir, { recursive: true, force: true });
		return { dir, night, plan, tick, finish, ledger, done };
	}

	test("one plan runs three nights, the cap each night, and never a key twice", () => {
		const h = host();
		try {
			h.plan(
				["a", "b", "c", "d", "e", "f"].map(
					(k) => `slack:C1:${k.charCodeAt(0)}.1`,
				),
			);
			for (let night = 0; night < 3; night++) {
				const base = N0 + night * DAY;
				h.tick(base + 60);
				h.finish();
				h.tick(base + 120);
				h.finish();
				h.tick(base + 180);
			}
			expect(h.ledger()).toEqual(
				["a", "b", "c", "d", "e", "f"].map(
					(k) => `slack:C1:${k.charCodeAt(0)}.1`,
				),
			);
		} finally {
			h.done();
		}
	});

	test("waits for the last session's turn to end", () => {
		const h = host();
		try {
			h.plan(["slack:C1:1.1", "slack:C1:2.2"]);
			h.tick(N0 + 60);
			h.tick(N0 + 120);
			expect(h.ledger()).toEqual(["slack:C1:1.1"]);
			writeFileSync(join(h.night, "stopped", "s-slack_C1_1.1"), "");
			h.tick(N0 + 180);
			expect(h.ledger()).toEqual(["slack:C1:1.1", "slack:C1:2.2"]);
		} finally {
			h.done();
		}
	});

	test("starts nothing outside the windows or after the plan's end", () => {
		const h = host();
		try {
			h.plan(["slack:C1:1.1"], { until: N0 + DAY });
			h.tick(N0 - 60);
			h.tick(N0 + 7 * 3600);
			h.tick(N0 + DAY + 60);
			expect(h.ledger()).toEqual([]);
		} finally {
			h.done();
		}
	});

	test("a new plan never restarts a key the ledger or the exclusions hold", () => {
		const h = host();
		try {
			h.plan(["slack:C1:1.1", "slack:C1:2.2"], { exclude: ["slack:C1:1.1"] });
			h.tick(N0 + 60);
			h.finish();
			h.plan(["slack:C1:2.2", "slack:C1:3.3"], { id: "p2" });
			h.tick(N0 + 120);
			expect(h.ledger()).toEqual(["slack:C1:2.2", "slack:C1:3.3"]);
		} finally {
			h.done();
		}
	});

	test("a start is in the ledger before its session, and a torn line is skipped", () => {
		const h = host();
		try {
			writeFileSync(
				join(h.night, "ran.jsonl"),
				'{"key": "slack:C1:1.1"}\n{"key": "sla',
			);
			h.plan(["slack:C1:1.1", "slack:C1:2.2"]);
			writeFileSync(join(h.dir, "bin", "tmux"), "#!/bin/sh\nexit 1\n", {
				mode: 0o755,
			});
			expect(() => h.tick(N0 + 60)).toThrow();
			expect(h.ledger()).toContain("slack:C1:2.2");
		} finally {
			h.done();
		}
	});

	test("a state file from before nights had their own is read as tonight's", () => {
		const h = host();
		try {
			h.plan(["slack:C1:1.1", "slack:C1:2.2", "slack:C1:3.3"]);
			writeFileSync(
				join(h.night, "state.json"),
				JSON.stringify({
					plan: "old",
					night: N0,
					started: [
						{ key: "slack:C1:1.1", sessionId: "x" },
						{ key: "slack:C1:2.2", sessionId: "y" },
					],
				}),
			);
			h.tick(N0 + 60);
			expect(h.ledger()).toEqual([]);
		} finally {
			h.done();
		}
	});

	test("with the queue done, it picks marked messages once a night, in Claude's order, and only listed ones", () => {
		const h = host();
		try {
			h.plan(["slack:C1:1.1"], {
				cap: 5,
				fallback: {
					script: `echo ${NIGHT_PANE_PLACEHOLDER} ${NIGHT_PANE_PLACEHOLDER.slice(0, 8)} ${NIGHT_PROMPT_B64_PLACEHOLDER} > "${h.dir}/script-$$"`,
					prompt: `${NIGHT_TASK_PLACEHOLDER} on odin/${NIGHT_PANE_PLACEHOLDER.slice(0, 8)}`,
					rank: "",
				},
			});
			const listed = JSON.stringify([
				{ key: "slack:D9:1.1", title: "first", url: "u1" },
				{ key: "slack:D9:2.2", title: "second", url: "u2" },
				{ key: "rm -rf /", title: "x", url: "" },
				{ key: "slack:C1:1.1", title: "ran", url: "" },
			]);
			const setup = [
				`r.marked = lambda now: (open(sys.argv[1] + "/listed", "a").write("x"), __import__("json").loads(${JSON.stringify(listed)}))[1]`,
				'r.rank = lambda cands, words: ["jira:EVIL-1", "slack:D9:2.2", "slack:D9:1.1"]',
			].join("\n");
			h.tick(N0 + 60, setup);
			h.finish();
			for (let i = 2; i <= 6; i++) {
				h.tick(N0 + 60 * i, setup);
				h.finish();
			}
			expect(h.ledger()).toEqual([
				"slack:C1:1.1",
				"slack:D9:2.2",
				"slack:D9:1.1",
			]);
			expect(readFileSync(join(h.dir, "listed"), "utf8")).toBe("x");
			const rows = readFileSync(join(h.night, "ran.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
			expect(rows[1]).toMatchObject({
				key: "slack:D9:2.2",
				url: "u2",
				picked: true,
			});
			const sid = rows[1].sessionId as string;
			const plan = JSON.parse(readFileSync(join(h.night, "state.json"), "utf8"))
				.nights[String(N0)].picked[0];
			expect(plan.script).toContain(`${sid} ${sid.slice(0, 8)} `);
			const prompt = Buffer.from(
				plan.script.split(" ")[3],
				"base64",
			).toString();
			expect(prompt).toContain("second");
			expect(prompt).toContain(`odin/${sid.slice(0, 8)}`);
			// The next night lists again.
			h.tick(N0 + DAY + 60, setup);
			expect(readFileSync(join(h.dir, "listed"), "utf8")).toBe("xx");
		} finally {
			h.done();
		}
	});
});
