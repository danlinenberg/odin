import { describe, expect, test } from "bun:test";
import { FEATURE_FLAGS, resolveFeatureFlags } from "./feature-flags";

describe("resolveFeatureFlags", () => {
	test("dev builds see every flag", () => {
		const flags = resolveFeatureFlags("dev");
		expect(Object.keys(flags)).toEqual(Object.keys(FEATURE_FLAGS));
		expect(Object.values(flags).every(Boolean)).toBe(true);
	});
});
