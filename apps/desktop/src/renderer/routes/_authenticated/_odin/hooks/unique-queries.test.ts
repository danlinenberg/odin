import { describe, expect, it } from "bun:test";
import { hashKey } from "@tanstack/react-query";
import { uniqueQueries } from "./unique-queries";

describe("uniqueQueries", () => {
	// What useBoardColumns asked for before: one pullRequestStates per card,
	// and every card that links no PR asks for the same empty list.
	it("folds the same key into one query, which react-query otherwise sees twice", () => {
		const urls = [[], ["https://github.com/o/r/pull/1"], []];
		const hashes = urls.map((list) =>
			hashKey([["terminal", "pullRequestStates"], { input: { urls: list } }]),
		);
		expect(new Set(hashes).size).toBeLessThan(hashes.length);
		const { unique, slot } = uniqueQueries(urls, (list) =>
			JSON.stringify(list),
		);
		const uniqueHashes = unique.map((list) =>
			hashKey([["terminal", "pullRequestStates"], { input: { urls: list } }]),
		);
		expect(new Set(uniqueHashes).size).toBe(uniqueHashes.length);
		expect(slot).toEqual([0, 1, 0]);
	});

	it("points every item at its own answer", () => {
		const panes = [
			{ paneId: "a", sessionId: "s1" },
			{ paneId: "b", sessionId: "s2" },
			{ paneId: "c", sessionId: "s1" },
		];
		const { unique, slot } = uniqueQueries(panes, (pane) => pane.sessionId);
		expect(unique.map((pane) => pane.sessionId)).toEqual(["s1", "s2"]);
		expect(panes.map((_, i) => unique[slot[i] ?? -1]?.sessionId)).toEqual([
			"s1",
			"s2",
			"s1",
		]);
	});

	it("passes distinct keys through in order", () => {
		const { unique, slot } = uniqueQueries(["x", "y"], (key) => key);
		expect(unique).toEqual(["x", "y"]);
		expect(slot).toEqual([0, 1]);
	});
});
