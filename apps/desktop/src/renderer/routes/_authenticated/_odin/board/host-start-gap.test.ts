import { describe, expect, it } from "bun:test";
import { hostStartDelay } from "./host-start-gap";

describe("hostStartDelay", () => {
	it("starts one Claude per host at a time, a gap apart", () => {
		expect(hostStartDelay("a", 1000, 100)).toBe(0);
		expect(hostStartDelay("a", 1000, 100)).toBe(100);
		expect(hostStartDelay("a", 1050, 100)).toBe(150);
	});

	it("keeps each host's turns apart from the others'", () => {
		expect(hostStartDelay("b", 1000, 100)).toBe(0);
		expect(hostStartDelay("c", 1000, 100)).toBe(0);
	});

	it("waits for nothing once the last start is a gap behind", () => {
		hostStartDelay("d", 1000, 100);
		expect(hostStartDelay("d", 2000, 100)).toBe(0);
	});
});
