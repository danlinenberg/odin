import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	NIGHT_PANE_PLACEHOLDER,
	NIGHT_PROMPT_B64_PLACEHOLDER,
	NIGHT_RUNNER_PY,
	parseNightRead,
	READ_NIGHT_PY,
} from "./night";

const PATH = process.env.PATH ?? "/usr/bin:/bin";
const T0 = 1_793_052_000;

/** A host in a folder: the runner, a tmux that only records, and a quiet machine. */
function host() {
	const dir = mkdtempSync(join(tmpdir(), "odin-sched-"));
	const night = join(dir, ".odin", "night");
	mkdirSync(night, { recursive: true });
	mkdirSync(join(dir, "bin"));
	mkdirSync(join(dir, "alive"));
	writeFileSync(join(dir, "night_runner.py"), NIGHT_RUNNER_PY);
	writeFileSync(join(night, "env"), "");
	writeFileSync(
		join(dir, "bin", "tmux"),
		`#!/bin/sh\ncase "$1" in\n  has-session) [ -e "${dir}/alive/$3" ] ;;\n  new-session) touch "${dir}/alive/$4" ;;\nesac\n`,
		{ mode: 0o755 },
	);
	const schedules = (at: number[], until = T0 + 3 * 86_400) =>
		writeFileSync(
			join(night, "schedules.json"),
			JSON.stringify({
				until,
				schedules: [
					{
						key: "a1",
						title: "Morning digest",
						script: `echo ${NIGHT_PROMPT_B64_PLACEHOLDER} --session-id ${NIGHT_PANE_PLACEHOLDER}`,
						prompt: `Digest for ${NIGHT_PANE_PLACEHOLDER}`,
						at,
					},
				],
			}),
		);
	const py = (now: number, call: string) =>
		execFileSync(
			"python3",
			[
				"-I",
				"-c",
				[
					"import sys, types; sys.path.insert(0, sys.argv[1]); import night_runner as r",
					`r.time = types.SimpleNamespace(time=lambda: ${now})`,
					'r.tempfile = types.SimpleNamespace(mkdtemp=lambda prefix, dir: __import__("tempfile").mkdtemp(prefix=prefix, dir=sys.argv[1]))',
					'r.read = lambda path: "MemTotal: 32000000 kB\\nMemAvailable: 30000000 kB\\n" if path.endswith("meminfo") else "0.1 0.1 0.1 1/1 1\\n"',
					call,
				].join("\n"),
				dir,
			],
			{ env: { PATH: `${join(dir, "bin")}:${PATH}`, HOME: dir } },
		).toString();
	const tick = (now: number) => py(now, "r.run_schedules()");
	const claim = (now: number, key: string) =>
		py(now, `r.claim(${JSON.stringify(key)})`).trim();
	const rows = (): Record<string, unknown>[] =>
		existsSync(join(night, "scheduled.jsonl"))
			? readFileSync(join(night, "scheduled.jsonl"), "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
			: [];
	const started = () => readdirSync(join(dir, "alive"));
	const scripts = () =>
		readdirSync(dir)
			.filter((name) => name.startsWith("odin."))
			.map((name) => readFileSync(join(dir, name, "run.sh"), "utf8"));
	const done = () => rmSync(dir, { recursive: true, force: true });
	return { dir, schedules, tick, claim, rows, started, scripts, done };
}

describe("automations on the host with the laptop away", () => {
	test("a run waits for the laptop, then starts once in a fresh session", () => {
		const h = host();
		try {
			h.schedules([T0]);
			h.tick(T0 + 30);
			expect(h.started()).toEqual([]);
			h.tick(T0 + 90);
			h.tick(T0 + 150);
			expect(h.started()).toHaveLength(1);
			const [row] = h.rows();
			expect(row).toMatchObject({
				key: `auto:a1:${T0}`,
				schedule: "a1",
				slot: T0,
				title: "Morning digest",
			});
			const sid = row?.sessionId as string;
			const [script] = h.scripts();
			expect(script).toBe(
				`echo ${Buffer.from(`Digest for ${sid}`).toString("base64")} --session-id ${sid}`,
			);
		} finally {
			h.done();
		}
	});

	test("a run the laptop took is never started on the host", () => {
		const h = host();
		try {
			h.schedules([T0]);
			expect(h.claim(T0 + 5, `auto:a1:${T0}`)).toBe("taken");
			h.tick(T0 + 120);
			expect(h.started()).toEqual([]);
			expect(h.claim(T0 + 130, `auto:a1:${T0}`)).toBe("already");
		} finally {
			h.done();
		}
	});

	test("the laptop can't take a run the host already started", () => {
		const h = host();
		try {
			h.schedules([T0]);
			h.tick(T0 + 100);
			expect(h.claim(T0 + 110, `auto:a1:${T0}`)).toBe("already");
		} finally {
			h.done();
		}
	});

	test("a late run, or a list past its end, starts nothing", () => {
		const h = host();
		try {
			h.schedules([T0]);
			h.tick(T0 + 601);
			expect(h.started()).toEqual([]);
			h.schedules([T0], T0 + 10);
			h.tick(T0 + 100);
			expect(h.started()).toEqual([]);
		} finally {
			h.done();
		}
	});

	test("the laptop's read lists the runs the host started, not the ones it took itself", () => {
		const h = host();
		try {
			h.schedules([T0, T0 + 900]);
			h.claim(T0 + 5, `auto:a1:${T0}`);
			h.tick(T0 + 1000);
			const read = parseNightRead(
				execFileSync("python3", ["-I", "-c", READ_NIGHT_PY], {
					env: { PATH, HOME: h.dir },
				}).toString(),
			);
			expect(read.scheduled.map((run) => run.key)).toEqual([
				`auto:a1:${T0 + 900}`,
			]);
		} finally {
			h.done();
		}
	});
});
