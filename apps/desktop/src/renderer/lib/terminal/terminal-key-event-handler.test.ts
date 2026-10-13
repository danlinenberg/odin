import { describe, expect, it } from "bun:test";
import type { Terminal as XTerm } from "@xterm/xterm";
import { createTerminalKeyEventHandler } from "./terminal-key-event-handler";

function keydown(overrides: Partial<KeyboardEvent>): KeyboardEvent {
	return {
		type: "keydown",
		key: "Enter",
		code: "Enter",
		metaKey: false,
		altKey: false,
		ctrlKey: false,
		shiftKey: false,
		preventDefault: () => {},
		...overrides,
	} as KeyboardEvent;
}

describe("createTerminalKeyEventHandler", () => {
	it("sends Ctrl+Enter to Claude as Send now instead of swallowing it", () => {
		const sent: string[] = [];
		const terminal = {
			input: (data: string) => sent.push(data),
		} as unknown as XTerm;
		const handle = createTerminalKeyEventHandler(terminal, { platform: "mac" });
		expect(handle(keydown({ ctrlKey: true }))).toBe(false);
		expect(sent).toEqual(["\x1b[13;5u"]);
	});
});
