import { describe, expect, it } from "bun:test";
import { DEFAULT_LAUNCH_LIMITS } from "shared/machine-load";
import { migrateLaunchLimits } from "./launch-limits";

describe("migrateLaunchLimits", () => {
	it("turns one-session-per-repo off for settings saved before the new default", () => {
		const saved = { ...DEFAULT_LAUNCH_LIMITS, oneSessionPerCheckout: true };
		expect(migrateLaunchLimits(saved, 0)).toMatchObject({
			oneSessionPerCheckout: false,
			maxWorkingAgents: DEFAULT_LAUNCH_LIMITS.maxWorkingAgents,
		});
	});

	it("keeps a choice made after the new default", () => {
		const saved = { ...DEFAULT_LAUNCH_LIMITS, oneSessionPerCheckout: true };
		expect(migrateLaunchLimits(saved, 1)).toMatchObject({
			oneSessionPerCheckout: true,
		});
	});
});
