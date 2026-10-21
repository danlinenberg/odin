import { expect, test } from "bun:test";
import {
	DROPPED_BY_HAND,
	droppedByHand,
	useBacklogReview,
} from "./useBacklogReview";

const review = (profileId: string) =>
	useBacklogReview.getState().profiles[profileId];

const jira = {
	key: "jira:ODIN-7",
	source: "Jira",
	title: "Old ticket",
	url: "https://x.atlassian.net/browse/ODIN-7",
};

test("a by-hand drop is a DROP whose evidence is you", () => {
	expect(droppedByHand(jira)).toEqual({
		...jira,
		verdict: "DROP",
		evidence: DROPPED_BY_HAND,
	});
	// A row with no link doesn't get a url field - the sweep's rows don't either.
	expect(droppedByHand({ key: "task:1", source: "Tasks", title: "t" })).toEqual(
		{
			key: "task:1",
			source: "Tasks",
			title: "t",
			verdict: "DROP",
			evidence: DROPPED_BY_HAND,
		},
	);
	expect(
		droppedByHand({ key: "task:2", source: "Tasks", title: "t", url: null }),
	).not.toHaveProperty("url");
});

test("a by-hand drop is listed under Dropped, newest first, with no sweep", () => {
	const store = useBacklogReview.getState();
	store.noteDropped("hand", droppedByHand(jira));
	store.noteDropped(
		"hand",
		droppedByHand({ ...jira, key: "task:9", title: "Later" }),
	);
	const dropped = review("hand")?.dropped ?? [];
	expect(dropped.map((row) => row.key)).toEqual(["task:9", "jira:ODIN-7"]);
	expect(dropped[1]).toMatchObject({
		verdict: "DROP",
		evidence: DROPPED_BY_HAND,
		url: jira.url,
	});
	expect(dropped[1]?.droppedAt).toBeGreaterThan(0);
	// Never swept, so it isn't among the rows the sweep flagged.
	expect(review("hand")?.swept).toEqual([]);
});

test("Undo takes a by-hand drop off Dropped", () => {
	const store = useBacklogReview.getState();
	store.noteDropped("undo", droppedByHand(jira));
	expect(review("undo")?.dropped).toHaveLength(1);
	store.unnoteDropped("undo", jira.key);
	expect(review("undo")?.dropped).toEqual([]);
});

test("a by-hand drop survives the next sweep, which never listed it", () => {
	const store = useBacklogReview.getState();
	store.noteDropped("sweep", droppedByHand(jira));
	store.record("sweep", [
		{
			key: "task:3",
			source: "Tasks",
			title: "x",
			verdict: "KEEP",
			evidence: "open",
		},
	]);
	expect(review("sweep")?.dropped.map((row) => row.key)).toEqual([jira.key]);
});
