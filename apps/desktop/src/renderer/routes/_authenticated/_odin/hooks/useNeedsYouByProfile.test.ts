import { describe, expect, it } from "bun:test";
import type { Pane } from "renderer/stores/tabs/types";
import { needsYouByProfile } from "./useNeedsYouByProfile";

const pane = (p: Partial<Pane> & { id: string }): Pane =>
	({
		type: "terminal",
		odinTaskTitle: "a task",
		...p,
	}) as Pane;

describe("needsYouByProfile", () => {
	it("counts waiting sessions per profile and leaves the rest out", () => {
		const panes = Object.fromEntries(
			[
				pane({ id: "a", status: "permission", odinProfile: "work" }),
				// Failed is the same call to action as a prompt.
				pane({ id: "b", status: "failed", odinProfile: "work" }),
				pane({ id: "c", status: "working", odinProfile: "work" }),
				pane({ id: "d", status: "permission", odinProfile: "private" }),
				// Unstamped panes predate profiles — they belong to "default".
				pane({ id: "e", status: "permission" }),
				// Not a board session: no task title.
				pane({ id: "f", status: "permission", odinTaskTitle: undefined }),
				// Dead: nothing left to answer.
				pane({ id: "g", status: "permission", odinProfile: "private" }),
			].map((p) => [p.id, p]),
		);
		const counts = needsYouByProfile(
			panes,
			new Set(["a", "b", "c", "d", "e", "f"]),
		);
		expect(counts.get("work")).toBe(2);
		expect(counts.get("private")).toBe(1);
		expect(counts.get("default")).toBe(1);
	});
});
