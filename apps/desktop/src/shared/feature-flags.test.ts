import { describe, expect, test } from "bun:test";
import { FEATURE_FLAGS, resolveFeatureFlags } from "./feature-flags";

describe("resolveFeatureFlags", () => {
	test("dev builds see every flag", () => {
		const flags = resolveFeatureFlags("dev");
		for (const flag of Object.keys(FEATURE_FLAGS)) {
			expect(flags[flag as keyof typeof FEATURE_FLAGS]).toBe(true);
		}
	});

	test("an internal flag is on in canary and off in stable", () => {
		expect(resolveFeatureFlags("canary").remoteSettings).toBe(true);
		expect(resolveFeatureFlags("stable").remoteSettings).toBe(false);
	});
});
