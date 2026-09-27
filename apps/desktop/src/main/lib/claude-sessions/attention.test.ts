import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BEAT_MS, readAttention, recordBeat } from "./attention";

describe("attention", () => {
	test("beats read back as spans per session; a torn line is skipped", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "attention-")), "a.jsonl");
		await recordBeat("s1", 100_000, path);
		await recordBeat("s1", 130_000, path);
		await recordBeat("s2", 200_000, path);
		const spans = await readAttention(path);
		expect(spans.get("s1")).toEqual([
			[100_000 - BEAT_MS, 100_000],
			[130_000 - BEAT_MS, 130_000],
		]);
		expect(spans.get("s2")?.length).toBe(1);
		expect((await readAttention(`${path}.missing`)).size).toBe(0);
	});
});
