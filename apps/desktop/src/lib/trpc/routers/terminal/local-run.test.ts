import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanOutput, readLocalRun, startLocalRun } from "./local-run";

describe("local runs", () => {
	test("keep the output and exit code, read once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "odin-local-run-"));
		const run = startLocalRun("echo hi; echo oops >&2; exit 3", dir);
		expect(await readLocalRun(run.id, dir)).toBeNull();
		const shown = execFileSync("bash", ["-c", run.command], {
			encoding: "utf8",
		});
		expect(shown).toContain("hi");
		expect(await readLocalRun(run.id, dir)).toEqual({
			exitCode: 3,
			output: "hi\noops",
		});
		expect(await readLocalRun(run.id, dir)).toBeNull();
	});

	test.skipIf(process.platform === "win32")(
		"in a terminal the command still has one",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "odin-local-run-"));
			const run = startLocalRun("[ -t 1 ] && echo tty; exit 4", dir);
			// script gives the wrapped command the terminal a Shell would.
			const args =
				process.platform === "darwin"
					? ["-q", "/dev/null", "/bin/bash", "-c", run.command]
					: ["-qec", run.command, "/dev/null"];
			execFileSync("script", args, {
				env: { PATH: process.env.PATH, SHELL: "/bin/bash" },
			});
			expect(await readLocalRun(run.id, dir)).toEqual({
				exitCode: 4,
				output: "tty",
			});
		},
	);

	test("a multi-line command with quotes runs as written", async () => {
		const dir = mkdtempSync(join(tmpdir(), "odin-local-run-"));
		const run = startLocalRun(`printf '%s\\n' "it's"\necho done`, dir);
		execFileSync("bash", ["-c", run.command]);
		expect(await readLocalRun(run.id, dir)).toEqual({
			exitCode: 0,
			output: "it's\ndone",
		});
	});
});

describe("cleanOutput", () => {
	test("drops colors and keeps what a redrawn line ended as", () => {
		expect(cleanOutput("\u001b[32mok\u001b[0m\n10%\r50%\r100%\r\n")).toBe(
			"ok\n100%",
		);
	});

	test("drops the frame util-linux script puts around it", () => {
		expect(
			cleanOutput(
				'Script started on 2026-10-26 [COMMAND="x"]\nok\r\n\nScript done on 2026-10-26 [COMMAND_EXIT_CODE="0"]\n',
			),
		).toBe("ok");
	});

	test("keeps the end of a long output", () => {
		expect(cleanOutput("abcdef", 3)).toBe("...\ndef");
	});
});
