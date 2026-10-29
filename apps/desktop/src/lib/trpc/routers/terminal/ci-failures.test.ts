import { expect, test } from "bun:test";
import { failedChecks, failedEntries, logExcerpt } from "./ci-failures";

const line = (text: string) =>
	`app\tRun bun run smoke\t2026-10-29T08:27:07.0038430Z ${text}`;

test("the excerpt keeps the lines around the error, without prefixes", () => {
	const raw = [
		"ok   boots",
		"ok   rail",
		"ok   tasks",
		"ok   settings",
		"ok   profiles",
		"FAIL the drawer opens",
		"##[group]noise",
		"\u001b[31m1 flow(s) broken\u001b[0m",
	]
		.map(line)
		.join("\n");
	expect(logExcerpt(raw)).toBe(
		"ok   settings\nok   profiles\nFAIL the drawer opens\n1 flow(s) broken",
	);
});

test("an empty log has no excerpt", () => {
	expect(logExcerpt("")).toBeNull();
});

test("only the newest run of a check counts", () => {
	expect(
		failedEntries([
			{ name: "test", conclusion: "FAILURE", startedAt: "1" },
			{ name: "test", conclusion: "SUCCESS", startedAt: "2" },
			{ name: "lint", conclusion: "FAILURE", startedAt: "1" },
			{ name: "old", conclusion: "CANCELLED", startedAt: "1" },
		]).map((e) => e.name),
	).toEqual(["lint"]);
});

test("an Actions job's failed log is read, a bot's check gets its link", async () => {
	const calls: string[][] = [];
	const exec = async (args: string[]) => {
		calls.push(args);
		if (args[0] === "pr")
			return {
				stdout: JSON.stringify({
					statusCheckRollup: [
						{
							name: "test",
							conclusion: "FAILURE",
							detailsUrl: "https://github.com/o/r/actions/runs/11/job/22",
						},
						{ context: "bot", state: "ERROR", targetUrl: "https://bot.dev/1" },
					],
				}),
			};
		return { stdout: "test\tstep\t2026-10-29T08:00:00Z error: boom" };
	};
	const checks = await failedChecks("https://github.com/o/r/pull/7", exec);
	expect(checks).toEqual([
		{
			name: "test",
			link: "https://github.com/o/r/actions/runs/11/job/22",
			log: "error: boom",
		},
		{ name: "bot", link: "https://bot.dev/1", log: null },
	]);
	expect(calls[1]).toEqual([
		"run",
		"view",
		"11",
		"--job",
		"22",
		"--log-failed",
		"-R",
		"o/r",
	]);
});
