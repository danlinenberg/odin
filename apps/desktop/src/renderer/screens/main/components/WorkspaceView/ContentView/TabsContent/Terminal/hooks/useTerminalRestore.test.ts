import { describe, expect, it } from "bun:test";
import { buildAltScreenRestore } from "./useTerminalRestore";

const ESC = "\x1b";
// What @xterm/addon-serialize emits for a session sitting in its alt screen:
// normal-buffer scrollback, then the alt-screen entry, then the live screen.
const snapshot = `shell history${ESC}[?1049h${ESC}[HClaude Code TUI`;

describe("buildAltScreenRestore", () => {
	it("writes the snapshot, so the pane is not left blank waiting for a repaint", () => {
		expect(
			buildAltScreenRestore({
				initialAnsi: snapshot,
				rehydrateSequences: `${ESC}[?2004h`,
			}),
		).toBe(`${snapshot}${ESC}[?2004h`);
	});

	it("drops the rehydrate alt-screen entry, which would blank the screen again", () => {
		const restore = buildAltScreenRestore({
			initialAnsi: snapshot,
			rehydrateSequences: `${ESC}[?1049h${ESC}[?47h${ESC}[?2004h`,
		});
		expect(restore.split(`${ESC}[?1049h`).length - 1).toBe(1);
		expect(restore).not.toContain(`${ESC}[?47h`);
		expect(restore.endsWith(`${ESC}[?2004h`)).toBe(true);
	});

	it("enters the alt screen itself when the snapshot has no entry sequence", () => {
		expect(
			buildAltScreenRestore({
				initialAnsi: "plain screen",
				rehydrateSequences: undefined,
			}),
		).toBe(`${ESC}[?1049hplain screen`);
	});
});
