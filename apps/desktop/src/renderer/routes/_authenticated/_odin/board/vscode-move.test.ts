import { describe, expect, test } from "bun:test";
import { moveToVsCode } from "./vscode-move";

describe("moveToVsCode", () => {
	test("opens the folder, then closes the session here, then sends it", async () => {
		const calls: string[] = [];
		const result = await moveToVsCode({
			openFolder: async () => {
				calls.push("open");
			},
			move: {
				closeHere: async () => {
					calls.push("close");
				},
				sendSession: async () => {
					calls.push("send");
					return true;
				},
			},
		});
		expect(calls).toEqual(["open", "close", "send"]);
		expect(result).toEqual({ opened: true, inPanel: true });
	});

	test("a folder that fails to open closes nothing and sends nothing", async () => {
		const calls: string[] = [];
		const result = await moveToVsCode({
			openFolder: async () => {
				throw new Error("no VS Code");
			},
			move: {
				closeHere: async () => {
					calls.push("close");
				},
				sendSession: async () => {
					calls.push("send");
					return true;
				},
			},
		});
		expect(calls).toEqual([]);
		expect(result.opened).toBe(false);
	});

	test("a failed send still reports the folder open, not in the panel", async () => {
		const result = await moveToVsCode({
			openFolder: async () => {},
			move: {
				closeHere: async () => {},
				sendSession: async () => {
					throw new Error("dropped");
				},
			},
		});
		expect(result).toEqual({ opened: true, inPanel: false });
	});
});
