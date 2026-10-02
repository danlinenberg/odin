import { describe, expect, it } from "bun:test";
import type { Pane } from "renderer/stores/tabs/types";
import { boardCountsByProfile, profileLabel } from "./useBoardCountsByProfile";

const pane = (p: Partial<Pane> & { id: string }): Pane =>
	({
		type: "terminal",
		odinTaskTitle: "a task",
		...p,
	}) as Pane;

describe("boardCountsByProfile", () => {
	it("counts waiting and working sessions per profile and leaves the rest out", () => {
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
				// Dead: nothing left to answer, and nothing working.
				pane({ id: "g", status: "permission", odinProfile: "private" }),
				pane({ id: "h", status: "working", odinProfile: "private" }),
				// Done is neither.
				pane({ id: "i", status: "review", odinProfile: "private" }),
			].map((p) => [p.id, p]),
		);
		const counts = boardCountsByProfile(
			panes,
			new Set(["a", "b", "c", "d", "e", "f", "i"]),
		);
		expect(counts.get("work")).toEqual({ needsYou: 2, working: 1 });
		expect(counts.get("private")).toEqual({ needsYou: 1, working: 0 });
		expect(counts.get("default")).toEqual({ needsYou: 1, working: 0 });
	});
});

describe("profileLabel", () => {
	it("names only the counts that aren't zero", () => {
		expect(profileLabel("Work", { needsYou: 9, working: 2 })).toBe(
			"Work · 9 needs you · 2 working",
		);
		expect(profileLabel("Work", { needsYou: 0, working: 2 })).toBe(
			"Work · 2 working",
		);
		expect(profileLabel("Work")).toBe("Work");
	});
});
