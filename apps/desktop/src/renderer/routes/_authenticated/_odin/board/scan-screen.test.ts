import { describe, expect, it } from "bun:test";
import { scanScreen } from "./scan-screen";

function reads(overrides: Partial<Parameters<typeof scanScreen>[2]> = {}) {
	const calls = { screen: 0, attach: 0 };
	return {
		calls,
		read: {
			visible: "",
			screen: async () => {
				calls.screen++;
				return "daemon screen";
			},
			attach: async () => {
				calls.attach++;
				return "snapshot tail";
			},
			...overrides,
		},
	};
}

describe("scanScreen", () => {
	it("attaches on a pane's first read, and reads the screen after that", async () => {
		const attached = new Set<string>();
		const { calls, read } = reads();
		expect(await scanScreen("p1", attached, read)).toBe("snapshot tail");
		expect(await scanScreen("p1", attached, read)).toBe("daemon screen");
		expect(await scanScreen("p1", attached, read)).toBe("daemon screen");
		expect(calls).toEqual({ screen: 2, attach: 1 });
	});

	it("reads a mounted terminal's screen without asking the daemon", async () => {
		const attached = new Set(["p1"]);
		const { calls, read } = reads({ visible: "xterm screen" });
		expect(await scanScreen("p1", attached, read)).toBe("xterm screen");
		expect(calls).toEqual({ screen: 0, attach: 0 });
	});

	it("falls back to an attach when the daemon can't say", async () => {
		const attached = new Set(["p1"]);
		const { calls, read } = reads({ screen: async () => null });
		expect(await scanScreen("p1", attached, read)).toBe("snapshot tail");
		expect(calls).toEqual({ screen: 0, attach: 1 });
	});

	it("tries the attach again on the next read when it failed", async () => {
		const attached = new Set<string>();
		let fail = true;
		const { calls, read } = reads({
			attach: async () => {
				calls.attach++;
				if (fail) throw new Error("daemon busy");
				return "snapshot tail";
			},
		});
		await expect(scanScreen("p1", attached, read)).rejects.toThrow(
			"daemon busy",
		);
		expect(attached.has("p1")).toBe(false);
		fail = false;
		expect(await scanScreen("p1", attached, read)).toBe("snapshot tail");
		expect(await scanScreen("p1", attached, read)).toBe("daemon screen");
		expect(calls).toEqual({ screen: 1, attach: 2 });
	});

	it("keeps each pane's first attach apart", async () => {
		const attached = new Set<string>();
		const { calls, read } = reads();
		await scanScreen("p1", attached, read);
		await scanScreen("p2", attached, read);
		await scanScreen("p1", attached, read);
		expect(calls).toEqual({ screen: 1, attach: 2 });
	});
});
