import { describe, expect, test } from "bun:test";
import type { Pane } from "shared/tabs-types";
import { statusAnnouncements } from "./StatusAnnouncer";

const pane = (id: string, status: Pane["status"], name = id) =>
	({ id, name, status }) as Pane;

describe("statusAnnouncements", () => {
	test("announces a move into needs-you, review or failed, not working", () => {
		const prev = new Map([
			["a", "working" as const],
			["b", "idle" as const],
			["c", "working" as const],
			["d", "permission" as const],
		]);
		const panes = {
			a: pane("a", "permission", "Fix login"),
			b: pane("b", "working"),
			c: pane("c", "failed"),
			d: pane("d", "permission"),
			e: pane("e", "review"), // new pane: not a transition
		};
		expect(statusAnnouncements(prev, panes)).toEqual([
			"Fix login: Needs you",
			"c: Failed",
		]);
	});
});
