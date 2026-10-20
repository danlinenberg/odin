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

	it("keeps a bare arrow key in the terminal even when the app binds it", () => {
		// Catch up binds the right arrow (CATCH_UP_SKIP). Arrows have no keypress,
		// so a keydown the terminal gives up never reaches the PTY: the cursor
		// stopped moving right while typing.
		const terminal = {
			input: () => {},
			hasSelection: () => false,
		} as unknown as XTerm;
		const handle = createTerminalKeyEventHandler(terminal, { platform: "mac" });
		expect(handle(keydown({ key: "ArrowRight", code: "ArrowRight" }))).toBe(
			true,
		);
	});

	it("keeps a bare Enter in the terminal even when the app binds it", () => {
		// CATCH_UP_ACCEPT is Enter.
		const terminal = {
			input: () => {},
			hasSelection: () => false,
		} as unknown as XTerm;
		const handle = createTerminalKeyEventHandler(terminal, { platform: "mac" });
		expect(handle(keydown({}))).toBe(true);
	});

	it("still hands an app chord with a modifier to the app", () => {
		// NEXT_SESSION: meta+alt+down on a Mac, ctrl+shift+alt+down elsewhere.
		// The resolver binds by the host OS, so the event is built for it.
		const mac = process.platform === "darwin";
		const terminal = {
			input: () => {},
			hasSelection: () => false,
		} as unknown as XTerm;
		const handle = createTerminalKeyEventHandler(terminal, { platform: "mac" });
		expect(
			handle(
				keydown({
					key: "ArrowDown",
					code: "ArrowDown",
					metaKey: mac,
					altKey: true,
					ctrlKey: !mac,
					shiftKey: !mac,
				}),
			),
		).toBe(false);
	});
});
