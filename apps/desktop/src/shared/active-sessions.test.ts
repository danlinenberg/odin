import { describe, expect, it } from "bun:test";
import { activeSessions } from "./active-sessions";
import type { Pane } from "./tabs-types";

const pane = (p: Partial<Pane> & { id: string }): Pane =>
	({
		type: "terminal",
		odinTaskTitle: p.id,
		...p,
	}) as Pane;

describe("activeSessions", () => {
	it("lists this profile's live sessions, needs-you first, with their source", () => {
		const panes = Object.fromEntries(
			[
				pane({
					id: "working",
					status: "working",
					odinSource: "jira",
					odinContact: "Ladis",
					odinTags: ["infra"],
					initialCwd: "/Users/dan/dev/odin/",
				}),
				pane({ id: "asking", status: "permission", odinSource: "reactions" }),
				// Dead: the daemon doesn't list it, so it isn't active.
				pane({ id: "dead", status: "working", odinSource: "pr" }),
				// Another profile's work.
				pane({ id: "other", status: "working", odinProfile: "work" }),
				// A terminal opened by hand, not a session.
				pane({ id: "plain", status: "working", odinTaskTitle: undefined }),
			].map((p) => [p.id, p]),
		);
		expect(
			activeSessions(
				panes,
				new Set(["working", "asking", "other", "plain"]),
				"default",
			),
		).toEqual([
			{
				paneId: "asking",
				title: "asking",
				source: "reactions",
				column: "permission",
				contact: null,
				tags: [],
				repo: null,
			},
			{
				paneId: "working",
				title: "working",
				source: "jira",
				column: "working",
				contact: "Ladis",
				tags: ["infra"],
				repo: "odin",
			},
		]);
	});
});
