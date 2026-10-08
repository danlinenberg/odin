import * as terminalCache from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache";

/**
 * What the mounted terminal is showing right now, as plain text. The board's
 * other screen reads go through the daemon and come back on a timer; a
 * keypress can't wait for that, and the xterm in the drawer already holds the
 * same rows.
 */
export function visibleScreen(paneId: string): string {
	const xterm = terminalCache.get(paneId)?.xterm;
	if (!xterm) return "";
	const buffer = xterm.buffer.active;
	const lines: string[] = [];
	for (let row = 0; row < xterm.rows; row++)
		lines.push(
			buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
		);
	return lines.join("\n");
}
