import { describe, expect, it } from "bun:test";
import {
	migrateRules,
	rulesPrompt,
	rulesSettings,
	useOdinRules,
} from "./odin-rules";

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
	const pinned = { ...rule, repos: ["/src/odin"] };

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
	const excluded = { ...rule, repos: ["/src/odin"], exclude: true };

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

describe("rules pinned to several repos", () => {
	const both = { ...rule, repos: ["/src/odin", "/src/app"] };

	it("reach sessions in any of them, and name them all", () => {
		const lines = rulesPrompt([both], "/src/app").join("\n");
		expect(lines).toContain("only in the repos at /src/odin, /src/app");
		expect(rulesPrompt([both], "/src/other")).toEqual([]);
	});

	it("excluding them skips every one", () => {
		const except = { ...both, exclude: true };
		expect(rulesPrompt([except], "/src/odin")).toEqual([]);
		expect(rulesPrompt([except], "/src/app")).toEqual([]);
		expect(rulesPrompt([except], "/src/other")).not.toEqual([]);
	});
});

it("migrates a v0 rule's single repo into repos", () => {
	const v0 = { rules: [{ ...rule, repo: "/src/odin", exclude: true }, rule] };
	expect(migrateRules(v0, 0)).toEqual({
		rules: [{ ...rule, repos: ["/src/odin"], exclude: true }, rule],
	});
});

describe("a rule whose repos an agent wrote as one string", () => {
	// action=run store=rules fn=update args=["<id>",{"repos":"/src/odin"}]
	const loose = { ...rule, repos: "/src/odin" as unknown as string[] };

	it("still reaches its repo, named, instead of blocking every session", () => {
		expect(rulesPrompt([loose], "/src/odin").join("\n")).toContain(
			"only in the repo at /src/odin",
		);
		expect(rulesPrompt([loose], "/src/other")).toEqual([]);
		expect(rulesSettings([loose], "/src/odin")).not.toBeNull();
	});

	it("is stored as a list, and junk repos are dropped", () => {
		const v1 = {
			rules: [
				loose,
				{ ...rule, id: "2", repos: 7 as unknown as string[] },
				{ ...rule, id: "3", repos: ["/src/app", 3, ""] as string[] },
			],
		};
		expect(migrateRules(v1, 1)).toEqual({
			rules: [
				{ ...rule, repos: ["/src/odin"] },
				{ ...rule, id: "2" },
				{ ...rule, id: "3", repos: ["/src/app"] },
			],
		});
	});
});

describe("the store takes an agent's lone repo string", () => {
	it("as a list, on add and on update", () => {
		const { add, update } = useOdinRules.getState();
		add("a test fails", "fix it", "/src/odin" as unknown as string[]);
		const added = useOdinRules.getState().rules.at(-1);
		expect(added?.repos).toEqual(["/src/odin"]);
		const id = added?.id ?? "";
		update(id, { repos: "/src/app" as unknown as string[] });
		expect(useOdinRules.getState().rules.at(-1)?.repos).toEqual(["/src/app"]);
		update(id, { repos: undefined });
		expect(useOdinRules.getState().rules.at(-1)).not.toHaveProperty("repos");
	});
});
