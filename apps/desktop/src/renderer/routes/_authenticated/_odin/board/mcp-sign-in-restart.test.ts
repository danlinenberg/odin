import { expect, test } from "bun:test";
import { MCP_SIGNED_IN_RETRY, mcpRestartKey } from "./mcp-sign-in-restart";

const signedOut = { at: "2026-11-23T09:30:00Z" };
const asked = {
	role: "user",
	text: "read the thread",
	at: "2026-11-23T09:29:00Z",
};
const replied = {
	role: "assistant",
	text: "Slack needs a sign-in.",
	at: "2026-11-23T09:31:00Z",
};

test("mcpRestartKey restarts once for a connector that lost its sign-in this turn", () => {
	expect(mcpRestartKey("p1", signedOut, [asked, replied])).toBe(
		"p1:2026-11-23T09:30:00Z",
	);
});

test("mcpRestartKey leaves a session with no lost sign-in alone", () => {
	expect(mcpRestartKey("p1", null, [asked, replied])).toBeNull();
	expect(mcpRestartKey("p1", { at: null }, [asked, replied])).toBeNull();
});

test("mcpRestartKey skips a failure from before your latest message", () => {
	const later = {
		role: "user",
		text: "next thing",
		at: "2026-11-23T09:40:00Z",
	};
	expect(mcpRestartKey("p1", signedOut, [asked, replied, later])).toBeNull();
});

test("mcpRestartKey does not restart again when the retry fails the same way", () => {
	const retry = {
		role: "user",
		text: MCP_SIGNED_IN_RETRY,
		at: "2026-11-23T09:29:00Z",
	};
	expect(mcpRestartKey("p1", signedOut, [retry, replied])).toBeNull();
});
