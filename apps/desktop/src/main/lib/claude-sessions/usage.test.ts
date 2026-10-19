import { expect, test } from "bun:test";
import { transcriptUsage } from "./usage";

const line = (id: string, model: string, usage: object) =>
	JSON.stringify({ type: "assistant", message: { id, model, usage } });

test("transcriptUsage counts each message once and prices it", () => {
	const jsonl = [
		line("a", "claude-opus-5-5", { input_tokens: 1, output_tokens: 5 }),
		// Same message, second content block: its final count wins.
		line("a", "claude-opus-5-5", {
			input_tokens: 1_000_000,
			output_tokens: 1_000_000,
		}),
		line("b", "us.anthropic.claude-opus-5-5", {
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: 1_000_000,
			cache_creation_input_tokens: 1_000_000,
			cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
		}),
	].join("\n");
	const usage = transcriptUsage(jsonl);
	// 4 + 20 + 0.2 read + 8 (1h write at 2x)
	expect(usage?.usd).toBeCloseTo(32.2);
	expect(usage?.tokens).toBe(4_000_000);
	expect(usage?.context).toBe(2_000_000);
	expect(transcriptUsage("")).toBeNull();
	// An error row at the end is not the context size.
	const errored = transcriptUsage(
		`${jsonl}\n${line("e", "<synthetic>", { input_tokens: 0 })}`,
	);
	expect(errored?.context).toBe(2_000_000);
	// An older, unpriced model: no cost, and a 200K window.
	const old = transcriptUsage(
		line("o", "claude-opus-4-1", { input_tokens: 5_000 }),
	);
	expect(old?.usd).toBeNull();
	expect(old?.window).toBe(200_000);
	expect(
		transcriptUsage(line("c", "gpt-x", { input_tokens: 1 }))?.usd,
	).toBeNull();
});

test("transcriptUsage: after /compact the context is the summary's size", () => {
	const reply = line("a", "claude-opus-5-5", { input_tokens: 720_000 });
	const boundary = JSON.stringify({
		type: "system",
		subtype: "compact_boundary",
		compactMetadata: { preTokens: 720_000, postTokens: 13_000 },
	});
	expect(transcriptUsage([reply, boundary].join("\n"))?.context).toBe(13_000);
	const next = line("b", "claude-opus-5-5", { input_tokens: 15_000 });
	expect(transcriptUsage([reply, boundary, next].join("\n"))?.context).toBe(
		15_000,
	);
});
