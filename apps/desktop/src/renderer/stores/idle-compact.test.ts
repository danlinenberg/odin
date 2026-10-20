import { describe, expect, test } from "bun:test";
import { migrateIdleCompact } from "./idle-compact";

describe("migrateIdleCompact", () => {
	test("a delay set under v0 means on", () => {
		expect(migrateIdleCompact({ minutes: 45 }, 0)).toEqual({ enabled: true });
	});

	test("v0's 0 = never means off", () => {
		expect(migrateIdleCompact({ minutes: 0 }, 0)).toEqual({ enabled: false });
		expect(migrateIdleCompact({}, 0)).toEqual({ enabled: false });
		expect(migrateIdleCompact(undefined, 0)).toEqual({ enabled: false });
	});

	test("v1 keeps the switch and drops nothing else", () => {
		expect(migrateIdleCompact({ enabled: true }, 1)).toEqual({ enabled: true });
	});
});
