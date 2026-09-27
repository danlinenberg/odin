/**
 * When you were actually looking at a session: its pane open in Odin, the
 * window focused, and you at the keyboard. Transcripts can only show the gap
 * before each prompt you sent; this sees the reading and watching in between.
 *
 * The board heartbeats every BEAT_MS while a pane is open; each beat that
 * passes the focus and idle checks is one line here, crediting the BEAT_MS
 * before it. Beats back to back weld into one span when merged.
 *
 * ponytail: append-only JSONL, ~50 bytes a beat (~2 MB a year of full days);
 * compact to spans if it ever matters.
 */

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ODIN_HOME_DIR } from "main/lib/app-environment";
import type { Interval } from "./workload";

export const BEAT_MS = 30_000;

export function attentionPath(): string {
	return join(ODIN_HOME_DIR, "attention.jsonl");
}

export async function recordBeat(
	sessionId: string,
	at = Date.now(),
	path = attentionPath(),
): Promise<void> {
	await appendFile(path, `${JSON.stringify({ s: sessionId, at })}\n`);
}

/** Beats as spans, by session. A missing or torn file reads as what's left. */
export async function readAttention(
	path = attentionPath(),
): Promise<Map<string, Interval[]>> {
	const out = new Map<string, Interval[]>();
	let text = "";
	try {
		text = await readFile(path, "utf-8");
	} catch {
		return out;
	}
	for (const line of text.split("\n")) {
		let beat: { s?: unknown; at?: unknown };
		try {
			beat = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof beat.s !== "string" || typeof beat.at !== "number") continue;
		const spans = out.get(beat.s) ?? [];
		spans.push([beat.at - BEAT_MS, beat.at]);
		out.set(beat.s, spans);
	}
	return out;
}
