import { describe, expect, it, mock } from "bun:test";

const opened: MockWriter[] = [];

class MockWriter {
	closed = false;
	async init(): Promise<void> {}
	async close(): Promise<void> {
		this.closed = true;
	}
	write(): void {}
}

mock.module("../../terminal-history", () => ({
	HistoryReader: class {},
	HistoryWriter: class extends MockWriter {
		constructor() {
			super();
			opened.push(this);
		}
	},
	truncateUtf8ToLastBytes: (text: string) => text,
}));

const { HistoryManager } = await import("./history-manager");

describe("HistoryManager", () => {
	it("closes the previous writer when a pane re-attaches", async () => {
		const manager = new HistoryManager();
		const args = {
			paneId: "pane-1",
			workspaceId: "ws-1",
			cwd: "/tmp",
			cols: 80,
			rows: 24,
		};

		await manager.initHistoryWriter(args);
		await manager.initHistoryWriter(args);
		await manager.initHistoryWriter(args);

		expect(opened.length).toBe(3);
		// Every writer but the live one is closed — otherwise each re-attach
		// leaks a scrollback fd until the process runs out.
		expect(opened.map((w) => w.closed)).toEqual([true, true, false]);
	});
});
