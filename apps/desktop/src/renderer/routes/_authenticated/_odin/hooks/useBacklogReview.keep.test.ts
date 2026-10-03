import { expect, test } from "bun:test";
import { migrateReview, useBacklogReview } from "./useBacklogReview";

const drop = {
	key: "task:1",
	source: "task",
	title: "t",
	verdict: "DROP" as const,
	evidence: "merged",
};

const review = (profileId: string) =>
	useBacklogReview.getState().profiles[profileId];

test("Keep turns a DROP into KEEP and survives the next sweep", () => {
	const store = useBacklogReview.getState();
	store.record("work", [drop]);
	store.keep("work", "task:1");
	expect(review("work")?.swept[0]?.verdict).toBe("KEEP");
	store.record("work", [drop]);
	expect(review("work")?.swept[0]?.verdict).toBe("KEEP");
	// Gone from the sweep, gone from kept.
	store.record("work", []);
	expect(review("work")?.kept).toEqual([]);
});

test("a profile never sees another profile's sweep", () => {
	const store = useBacklogReview.getState();
	store.record("work", [drop]);
	store.record("private", []);
	store.noteDropped("private", { ...drop, key: "slack:D1:1" });
	expect(review("work")?.swept).toHaveLength(1);
	expect(review("work")?.dropped).toEqual([]);
	expect(review("private")?.swept).toEqual([]);
	expect(review("fresh")).toBeUndefined();
});

test("the one pre-profile sweep moves to the default profile", () => {
	expect(
		migrateReview(
			{ swept: [drop], sweptAt: 5, kept: [], dropped: [], sweepEveryHours: 2 },
			0,
		),
	).toEqual({
		sweepEveryHours: 2,
		profiles: {
			default: { swept: [drop], sweptAt: 5, kept: [], dropped: [] },
		},
	});
});
