import { describe, expect, it } from "bun:test";
import { rulesPrompt, rulesSettings } from "./odin-rules";

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

describe("repo-pinned rules", () => {
	const pinned = { ...rule, repo: "/src/odin" };

	it("reach sessions in that repo or its worktrees", () => {
		for (const cwd of ["/src/odin", "/src/odin/.worktrees/x"]) {
			expect(rulesPrompt([pinned], cwd).join("\n")).toContain(
				"only in the repo at /src/odin",
			);
			expect(rulesSettings([pinned], cwd)).not.toBeNull();
		}
	});

	it("skip sessions in another repo", () => {
		expect(rulesPrompt([pinned], "/src/odin-other")).toEqual([]);
		expect(rulesSettings([pinned], "/src/other")).toBeNull();
	});

	it("go out named when the checkout isn't known", () => {
		expect(rulesPrompt([pinned]).join("\n")).toContain(
			"only in the repo at /src/odin",
		);
	});
});

describe("repo-excluded rules", () => {
	const excluded = { ...rule, repo: "/src/odin", exclude: true };

	it("skip sessions in that repo or its worktrees", () => {
		for (const cwd of ["/src/odin", "/src/odin/.worktrees/x"]) {
			expect(rulesPrompt([excluded], cwd)).toEqual([]);
			expect(rulesSettings([excluded], cwd)).toBeNull();
		}
	});

	it("reach every other session, the exception named", () => {
		for (const cwd of ["/src/other", ""]) {
			expect(rulesPrompt([excluded], cwd).join("\n")).toContain(
				"except in the repo at /src/odin",
			);
		}
	});
});
