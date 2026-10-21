import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSubagents } from "./subagents";

const launch = (id: string, description: string) =>
	`${JSON.stringify({
		type: "assistant",
		timestamp: "2026-10-21T10:20:00.000Z",
		message: {
			content: [
				{
					type: "tool_use",
					id,
					name: "Agent",
					input: { description, prompt: "." },
				},
			],
		},
	})}\n`;

const report = (id: string, text: string) =>
	`${JSON.stringify({
		type: "user",
		timestamp: "2026-10-21T10:21:00.000Z",
		message: {
			content: [{ type: "tool_result", tool_use_id: id, content: text }],
		},
	})}\n`;

describe("readSubagents", () => {
	let root: string;
	let file: string;
	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "subagents-"));
		await mkdir(join(root, "-home-dan-dev"), { recursive: true });
		file = join(root, "-home-dan-dev", "s1.jsonl");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test("no transcript: nothing known, not an error", async () => {
		expect(await readSubagents({ sessionId: "nope", root })).toEqual([]);
	});

	test("folds what is appended since the last read, and only that", async () => {
		await writeFile(file, launch("t1", "First"));
		expect(
			(await readSubagents({ sessionId: "s1", root })).map((a) => a.status),
		).toEqual(["running"]);
		// An unchanged file is a stat, not a read.
		expect(await readSubagents({ sessionId: "s1", root })).toHaveLength(1);
		await appendFile(file, report("t1", "done it") + launch("t2", "Second"));
		await utimes(file, new Date(), new Date(Date.now() + 5000));
		const agents = await readSubagents({ sessionId: "s1", root });
		expect(agents.map((a) => [a.description, a.status, a.result])).toEqual([
			["Second", "running", null],
			["First", "done", "done it"],
		]);
	});

	test("a half-written line waits for its end", async () => {
		const line = report("t1", "finished");
		await writeFile(file, launch("t1", "First") + line.slice(0, 40));
		expect((await readSubagents({ sessionId: "s1", root }))[0]?.status).toBe(
			"running",
		);
		await appendFile(file, line.slice(40));
		await utimes(file, new Date(), new Date(Date.now() + 5000));
		expect((await readSubagents({ sessionId: "s1", root }))[0]?.status).toBe(
			"done",
		);
	});

	test("a file rewritten shorter is read again from the top", async () => {
		await writeFile(file, launch("t1", "First") + launch("t2", "Second"));
		expect(await readSubagents({ sessionId: "s1", root })).toHaveLength(2);
		await writeFile(file, launch("t3", "Third"));
		await utimes(file, new Date(), new Date(Date.now() + 5000));
		expect(
			(await readSubagents({ sessionId: "s1", root })).map(
				(a) => a.description,
			),
		).toEqual(["Third"]);
	});
});
