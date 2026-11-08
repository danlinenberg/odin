import { expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { hostReady } from "../../renderer/routes/_authenticated/_odin/board/host-delivery";
import { remoteConnectLine } from "../../shared/odin-screen-status";
import { LEAVE_TMUX_SCREEN } from "./reconnect";

const screenOf = (term: Terminal) => {
	const buffer = term.buffer.active;
	const rows: string[] = [];
	for (let i = 0; i < term.rows; i++)
		rows.push(
			buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? "",
		);
	return rows.join("\n");
};

const write = (term: Terminal, data: string) =>
	new Promise<void>((resolve) => term.write(data, () => resolve()));

/** A pane attached to Claude in tmux whose connection then drops. */
async function droppedPane(reset: string): Promise<string> {
	const term = new Terminal({ cols: 80, rows: 12, allowProposedApi: true });
	await write(term, "\r\nOdin: connecting to i-0abc...\r\n");
	// tmux takes the full screen and draws Claude, cursor in its input box.
	await write(term, "\x1b[?1049h\x1b[?1000h\x1b[H\x1b[2J");
	const rule = "─".repeat(80);
	const rows = [
		"● Done.",
		"",
		rule,
		"> ",
		rule,
		"  ⏵⏵ bypass permissions on (shift+tab to cycle)",
		"",
		"",
		"",
		"",
		"",
		"[odin-abc:claude*",
	];
	await write(term, rows.map((row, i) => `\x1b[${i + 1};1H${row}`).join(""));
	await write(term, "\x1b[4;3H");
	// The connection drops: what the helper writes next.
	await write(
		term,
		`${reset}\r\nOdin: connection lost - reconnecting to i-0abc...\r\n`,
	);
	return screenOf(term);
}

test("without the reset, a dropped tmux screen still reads as Claude ready", async () => {
	const screen = await droppedPane("");
	expect(remoteConnectLine(screen)).toBeUndefined();
	expect(hostReady(screen)).toBe(true);
});

test("after a drop the pane reads as reconnecting, not as Claude ready", async () => {
	const screen = await droppedPane(LEAVE_TMUX_SCREEN);
	expect(remoteConnectLine(screen)).toBe(
		"Connection lost - reconnecting to i-0abc...",
	);
	expect(hostReady(screen)).toBe(false);
});
