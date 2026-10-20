import { expect, test } from "bun:test";
import {
	doneChecker,
	migrateDone,
	sessionDocKey,
	sessionIdOfDocKey,
} from "./done";

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

test("a mention newer than Done brings the row back", () => {
	const at = Date.parse("2026-10-01T12:00:00Z");
	const url = "https://x.atlassian.net/browse/SHIP-1";
	const isDone = doneChecker({
		"jira:SHIP-1": { at, title: "SHIP-1", source: "Jira", url },
	});
	const asked = (when: string) => ({ author: "Noa", at: when, text: "" });
	expect(isDone({ key: "jira:SHIP-1" })).toBe(true);
	expect(
		isDone({ key: "jira:SHIP-1", mention: asked("2026-09-30T09:00:00+0300") }),
	).toBe(true);
	expect(
		isDone({
			key: "jira:SHIP-1",
			mention: asked("2026-10-04T14:52:45.574+0300"),
		}),
	).toBe(false);
	// Matched by link too, as PRs are.
	expect(
		isDone({
			key: "other",
			url,
			mention: asked("2026-10-04T14:52:45.574+0300"),
		}),
	).toBe(false);
	expect(isDone({ key: "jira:SHIP-2" })).toBe(false);
});

test("a session's Docs row is keyed by its conversation, apart from feed rows", () => {
	const key = sessionDocKey("4f2c-abc");
	expect(sessionIdOfDocKey(key)).toBe("4f2c-abc");
	expect(sessionIdOfDocKey("jira:SHIP-1")).toBeNull();
	expect(sessionIdOfDocKey("task:session:1")).toBeNull();
	// Never mistaken for a feed row's Done: the checker goes by key or link.
	const isDone = doneChecker({
		[key]: { at: 1, title: "Brainstorm", source: "session", url: null },
	});
	expect(isDone({ key: "jira:SHIP-1" })).toBe(false);
});
