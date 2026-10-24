import { expect, test } from "bun:test";
import { demoAnswer } from "./demo";

const json = async (response: Response) => response.json();

test("a single call (the slow queries, every mutation) gets one result with its input", async () => {
	const brief = await json(
		demoAnswer(
			"/trpc/brief",
			`input=${encodeURIComponent('{"json":{"paneId":"p1"}}')}`,
			"",
		),
	);
	expect(brief.result.data.json.goal).toContain("HDR grouping");
	const star = await json(
		demoAnswer("/trpc/star", "", '{"json":{"paneId":"p1","starred":true}}'),
	);
	expect(star.result.data.json).toBe("ok");
});

test("a batch gets one result per procedure", async () => {
	const answers = await json(
		demoAnswer(
			"/trpc/profiles,session",
			`batch=1&input=${encodeURIComponent('{"0":{"json":null},"1":{"json":{"paneId":"p1"}}}')}`,
			"",
		),
	);
	expect(answers).toHaveLength(2);
	expect(answers[1].result.data.json.title).toBe("Fix HDR grouping test");
});
