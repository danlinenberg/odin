import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { ODIN_HOME_DIR } from "./app-environment";

/**
 * When Odin freezes, ~/.odin/freeze.log says which process stalled and, for
 * the window, which scripts held it (the renderer reports long animation
 * frames as `[freeze]` console lines - see renderer/lib/freeze-reporter.ts).
 * Nothing else records a stall in a release build, so a "clicks do nothing
 * for a few seconds" report had no trace to read.
 */
const LOG_PATH = join(ODIN_HOME_DIR, "freeze.log");
const TICK_MS = 250;
const STALL_MS = 1_000;

function write(line: string): void {
	void appendFile(LOG_PATH, `${new Date().toISOString()} ${line}\n`).catch(
		() => {},
	);
}

/** Main's event loop: a tick that lands late by a second was blocked. */
export function startMainStallLog(): void {
	let last = performance.now();
	setInterval(() => {
		const now = performance.now();
		const late = now - last - TICK_MS;
		last = now;
		if (late >= STALL_MS) write(`main blocked ${Math.round(late)}ms`);
	}, TICK_MS).unref();
}

export function attachWindowFreezeLog(window: BrowserWindow): void {
	let since = 0;
	window.on("unresponsive", () => {
		since = Date.now();
		write("window unresponsive");
	});
	window.on("responsive", () => {
		if (since) write(`window responsive after ${Date.now() - since}ms`);
		since = 0;
	});
	window.webContents.on("console-message", (_event, _level, message) => {
		if (message.startsWith("[freeze] ")) write(`window ${message.slice(9)}`);
	});
}
