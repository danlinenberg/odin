/** What a conversation has used, from the `usage` Claude Code logs per API message. */
export interface SessionUsage {
	/** Every token in and out, cache reads and writes included. */
	tokens: number;
	/** The latest message's prompt size - what the context holds right now. */
	context: number;
	window: number;
	/** At Anthropic API list prices; null for a model not in the table. */
	usd: number | null;
}

/** $ per million tokens: input, output, cache read. Writes are 1.25x input (5m), 2x (1h). */
const PRICES: [prefix: string, input: number, output: number, read: number][] =
	[
		["claude-fable-5-1", 10, 50, 0.25],
		["claude-mythos-5-1", 10, 50, 0.25],
		["claude-fable-5", 10, 50, 1],
		["claude-mythos-5", 10, 50, 1],
		["claude-opus-5-5", 4, 20, 0.2],
		["claude-opus-5", 5, 25, 0.5],
		["claude-opus-4", 5, 25, 0.5],
		["claude-sonnet-5", 2, 10, 0.2],
		["claude-sonnet-4", 3, 15, 0.3],
		// ponytail: Haiku 5.5 prompts past 100K cost 5x; not split out.
		["claude-haiku-5", 0.1, 0.5, 0.01],
		["claude-haiku-4", 1, 5, 0.1],
	];

interface Usage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_creation?: {
		ephemeral_5m_input_tokens?: number;
		ephemeral_1h_input_tokens?: number;
	};
}

export function transcriptUsage(jsonl: string): SessionUsage | null {
	// Claude Code writes one line per content block, each repeating its
	// message's usage - the last line of a message has its final count.
	const byMessage = new Map<string, { model: string; usage: Usage }>();
	for (const line of jsonl.split("\n")) {
		if (!line.includes('"usage"')) continue;
		try {
			const { message } = JSON.parse(line) as {
				message?: { id?: string; model?: string; usage?: Usage };
			};
			if (message?.id && message.usage)
				byMessage.set(message.id, {
					model: message.model ?? "",
					usage: message.usage,
				});
		} catch {}
	}
	if (!byMessage.size) return null;
	let tokens = 0;
	let usd: number | null = 0;
	let last: Usage = {};
	for (const { model, usage } of byMessage.values()) {
		const input = usage.input_tokens ?? 0;
		const output = usage.output_tokens ?? 0;
		const read = usage.cache_read_input_tokens ?? 0;
		const written = usage.cache_creation_input_tokens ?? 0;
		const hour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
		tokens += input + output + read + written;
		last = usage;
		if (model === "<synthetic>") continue; // Claude Code's own error rows
		const price = PRICES.find(([prefix]) =>
			model.replace(/^.*?(claude-)/, "$1").startsWith(prefix),
		);
		if (!price || usd === null) {
			usd = null;
			continue;
		}
		const [, inRate, outRate, readRate] = price;
		usd +=
			(input * inRate +
				output * outRate +
				read * readRate +
				(written - hour) * inRate * 1.25 +
				hour * inRate * 2) /
			1e6;
	}
	const context =
		(last.input_tokens ?? 0) +
		(last.cache_read_input_tokens ?? 0) +
		(last.cache_creation_input_tokens ?? 0);
	// ponytail: every current model has 1M; a bigger prompt than 200K proves it on older ones.
	const window =
		[...byMessage.values()].at(-1)?.model.includes("haiku-4") &&
		context <= 200_000
			? 200_000
			: 1_000_000;
	return { tokens, context, window, usd };
}
