import { expect, test } from "bun:test";
import { transcriptCredential } from "./credential";

const request = (betas: string[], timestamp: string) =>
	JSON.stringify({
		type: "api-request",
		timestamp,
		params: { model: "claude-opus-5-5", betas },
	});
const PLAN = ["claude-code-20250219", "oauth-2025-04-20", "effort-2025-11-24"];
const KEY = ["claude-code-20250219", "effort-2025-11-24"];

test("transcriptCredential reads the plan or the key off the latest request", () => {
	expect(transcriptCredential("")).toBeNull();
	expect(
		transcriptCredential(JSON.stringify({ type: "assistant", message: {} })),
	).toBeNull();
	expect(transcriptCredential(request(PLAN, "2026-10-19T10:00:00Z"))).toEqual({
		now: "plan",
		since: null,
	});
	expect(transcriptCredential(request(KEY, "2026-10-19T10:00:00Z"))).toEqual({
		now: "key",
		since: null,
	});
});

test("transcriptCredential dates the move from the plan to the key", () => {
	const jsonl = [
		request(PLAN, "2026-10-19T10:00:00Z"),
		request(PLAN, "2026-10-19T10:05:00Z"),
		// The plan ran out; the session resumed on the key.
		request(KEY, "2026-10-19T10:15:00Z"),
		request(KEY, "2026-10-19T10:20:00Z"),
	].join("\n");
	expect(transcriptCredential(jsonl)).toEqual({
		now: "key",
		since: "2026-10-19T10:15:00Z",
	});
	// A turn quoting the row type, a request-shape row and a broken line are
	// not requests.
	const noise = [
		JSON.stringify({ type: "user", message: { content: '"api-request"' } }),
		JSON.stringify({ type: "api-request-shape", params: { betas: PLAN } }),
		'{"type":"api-request"',
	];
	expect(transcriptCredential([jsonl, ...noise].join("\n"))).toEqual({
		now: "key",
		since: "2026-10-19T10:15:00Z",
	});
});
