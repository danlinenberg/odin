import { describe, expect, mock, test } from "bun:test";
import type { HostLoadReading } from "shared/host-load";

let probes = 0;
mock.module("./ssh", () => ({
	connectHost: async () => {
		probes++;
		throw new Error("no host in tests");
	},
	runOnHost: async () => "",
}));
const { hostLoad, recordHostLoad } = await import("./host-load");

describe("hostLoad", () => {
	test("a cached reading from before the last start doesn't count", async () => {
		const at = Date.now() - 1_000;
		recordHostLoad({ instanceId: "i-1", at } as HostLoadReading);
		const host = { instanceId: "i-1" } as Parameters<typeof hostLoad>[0];

		expect((await hostLoad(host, 1_000, at - 1))?.at).toBe(at);
		expect(probes).toBe(0);

		expect(await hostLoad(host, 1_000, at + 1)).toBeNull();
		expect(probes).toBe(1);
	});
});
