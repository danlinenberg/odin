import { expect, test } from "bun:test";
import { migrateDone } from "./done";

test("v0 done timestamps and hidden keys both come through as done", () => {
	const store = new Map([
		[
			"odin-hidden-items",
			JSON.stringify({ state: { hidden: { "pr:7": true } } }),
		],
	]);
	const real = globalThis.localStorage;
	globalThis.localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		removeItem: (k: string) => void store.delete(k),
	} as Storage;
	const { done } = migrateDone({ done: { "jira:AB-1": 5 } });
	globalThis.localStorage = real;
	expect(done["jira:AB-1"]).toMatchObject({
		at: 5,
		source: "jira",
		title: "AB-1",
	});
	expect(done["pr:7"]?.source).toBe("pr");
});
