import { describe, expect, it } from "bun:test";
import { rulesSettings } from "./odin-rules";

const rule = {
	id: "1",
	when: "you open a pull request",
	action: "run /custom-review it's",
};

function fire(input: string): string {
	const settings = JSON.parse(rulesSettings([rule]) ?? "{}");
	const { command } = settings.hooks.PostToolUse[0].hooks[0];
	const run = Bun.spawnSync(["sh", "-c", command], {
		stdin: Buffer.from(input),
	});
	expect(run.exitCode).toBe(0);
	return run.stdout.toString();
}

describe("rulesSettings", () => {
	it("fires the PR rule on gh pr create and on every push", () => {
		for (const cmd of ["gh pr create --base main", "git push -u origin x"]) {
			const out = JSON.parse(
				fire(JSON.stringify({ tool_input: { command: cmd } })),
			);
			expect(out.hookSpecificOutput.additionalContext).toContain(
				"When you open a pull request: run /custom-review it's",
			);
		}
	});

	it("stays silent on other Bash calls", () => {
		expect(fire(JSON.stringify({ tool_input: { command: "ls" } }))).toBe("");
	});

	it("is null without a live PR rule", () => {
		expect(rulesSettings([{ ...rule, paused: true }])).toBeNull();
		expect(rulesSettings([{ ...rule, when: "a test fails" }])).toBeNull();
	});
});
