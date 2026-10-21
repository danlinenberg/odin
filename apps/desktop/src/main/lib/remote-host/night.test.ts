import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_HOST_FREE_MEMORY_SHARE } from "shared/launch-gate";
import { NIGHT_RUNNER_PY } from "./night";

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
});
