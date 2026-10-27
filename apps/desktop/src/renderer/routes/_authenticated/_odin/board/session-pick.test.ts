import { describe, expect, it } from "bun:test";
import { mergePrompt, parkable, resumable } from "./session-pick";

const card = (
	id: string,
	status: "idle" | "working" | "permission" | "review",
	queued = false,
) => ({
	status,
	pane: {
		id,
		odinQueued: queued ? { command: "claude", reason: "busy" } : undefined,
	},
});

describe("resumable", () => {
	it("takes the closed Idle rows and the queued ones, leaves live sessions alone", () => {
		const closed = card("closed", "idle");
		const parkedLive = card("parked", "idle");
		const queued = card("queued", "idle", true);
		const working = card("working", "working");
		const asking = card("asking", "permission");
		const picked = resumable(
			[closed, parkedLive, queued, working, asking],
			new Set(["parked", "working", "asking"]),
		);
		expect(picked.map((c) => c.pane.id)).toEqual(["closed", "queued"]);
	});

	it("keeps the rows' order", () => {
		const picked = resumable([card("b", "idle"), card("a", "idle")], new Set());
		expect(picked.map((c) => c.pane.id)).toEqual(["b", "a"]);
	});
});

describe("parkable", () => {
	it("takes every row not already in Idle", () => {
		const picked = parkable([
			card("idle", "idle"),
			card("working", "working"),
			card("done", "review"),
			card("asking", "permission"),
		]);
		expect(picked.map((c) => c.pane.id)).toEqual(["working", "done", "asking"]);
	});
});

describe("mergePrompt", () => {
	it("titles the merge and lists each session's ask, transcript and status", () => {
		const prompt = mergePrompt([
			{
				title: "Fix login",
				brief: "Fix login\nUsers get a 500 on SSO",
				sessionId: "abc",
				status: "PR open",
				cwd: "/repo/a",
			},
			{ title: "Add logout", brief: null },
		]);
		expect(prompt.split("\n")[0]).toBe("Merged: Fix login + Add logout");
		expect(prompt).toContain("These 2 sessions are merged");
		expect(prompt).toContain(
			"## 1. Fix login\nTranscript: ~/.claude/projects/*/abc.jsonl\nCheckout: /repo/a\nLast status: PR open\n\nUsers get a 500 on SSO",
		);
		expect(prompt.endsWith("## 2. Add logout")).toBe(true);
	});
});
