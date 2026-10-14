import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createFrameHeader, PtySubprocessIpcType } from "./pty-subprocess-ipc";
import "./xterm-env-polyfill";

// Must import after polyfill since these transitively load @xterm/headless
const { Session } = await import("./session");

class FakeStdin extends EventEmitter {
	readonly writes: Buffer[] = [];
	write(chunk: Buffer | string): boolean {
		this.writes.push(
			Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"),
		);
		return true;
	}
}

class FakeChildProcess extends EventEmitter {
	readonly stdout = new (class extends EventEmitter {
		write(): boolean {
			return true;
		}
	})();
	readonly stdin = new FakeStdin();
	pid = 4242;
	kill(): boolean {
		return true;
	}
}

/** Write frames the session sent to its PTY subprocess. */
function ptyWrites(child: FakeChildProcess): number {
	return child.stdin.writes.filter(
		(frame) =>
			frame.length >= 5 && frame.readUInt8(0) === PtySubprocessIpcType.Write,
	).length;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Session.holdKey", () => {
	it("repeats the key until releaseKey, then stops", async () => {
		const child = new FakeChildProcess();
		const session = new Session({
			sessionId: "s",
			workspaceId: "w",
			paneId: "p",
			tabId: "t",
			cols: 80,
			rows: 24,
			cwd: "/tmp",
			shell: "/bin/bash",
			spawnProcess: () => child as unknown as ChildProcess,
		});
		session.spawn({ cwd: "/tmp", cols: 80, rows: 24, env: {} });
		child.stdout.emit("data", createFrameHeader(PtySubprocessIpcType.Ready, 0));
		const before = ptyWrites(child);
		session.holdKey(" ", 20);
		// A slow CI box fires fewer ticks; 300ms at 20ms leaves room for that.
		await sleep(300);
		const held = ptyWrites(child) - before;
		expect(held).toBeGreaterThanOrEqual(5);
		session.releaseKey();
		await sleep(100);
		expect(ptyWrites(child) - before).toBe(held);
	});
});
