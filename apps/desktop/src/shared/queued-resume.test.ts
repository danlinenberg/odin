import { describe, expect, it } from "bun:test";
import { isQueuedResume } from "./queued-resume";

describe("isQueuedResume", () => {
	it("is true for a local Resume held at the gate", () => {
		expect(
			isQueuedResume({
				command: "cd '/repo' && claude --resume abc Continue",
				reason: "another agent is working in this checkout",
			}),
		).toBe(true);
	});

	it("is false for a local launch that never started", () => {
		expect(
			isQueuedResume({
				command: "cd '/repo' && claude --session-id abc 'Do the task'",
				reason: "the Mac is busy",
			}),
		).toBe(false);
	});

	it("reads a host launch from its args", () => {
		const remote = { pane: "p", repoPath: null, prompt: null };
		expect(
			isQueuedResume({
				command: "",
				reason: "host is full",
				remote: { ...remote, claudeArgs: "--resume abc" },
			}),
		).toBe(true);
		expect(
			isQueuedResume({
				command: "",
				reason: "host is full",
				remote: { ...remote, claudeArgs: "--session-id abc" },
			}),
		).toBe(false);
	});
});
