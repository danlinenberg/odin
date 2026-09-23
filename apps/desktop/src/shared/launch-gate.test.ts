import { describe, expect, it } from "bun:test";
import { launchBlocker } from "./launch-gate";
import type { Pane } from "./tabs-types";

const ODIN = "/Users/dan/dev/odin";

const pane = (p: Partial<Pane>) => p as Pane;

describe("launchBlocker", () => {
	it("clears a launch outside Odin's checkout", () => {
		expect(launchBlocker([], "/tmp/repo", ODIN)).toBeNull();
	});

	it("holds a second agent out of Odin's own checkout", () => {
		const held = [
			pane({ id: "a", status: "working", initialCwd: ODIN, name: "x" }),
		];
		expect(launchBlocker(held, ODIN, ODIN)).toBe(
			'waiting for "x" to finish in Odin\'s checkout',
		);
		// Another repo is unaffected — the gate is about the one checkout.
		expect(launchBlocker(held, "/tmp/repo", ODIN)).toBeNull();
	});

	it("lets a queued Odin task through once the one ahead finishes", () => {
		const done = [
			pane({ id: "a", status: "review", initialCwd: ODIN, name: "x" }),
		];
		expect(launchBlocker(done, ODIN, ODIN)).toBeNull();
	});
});
