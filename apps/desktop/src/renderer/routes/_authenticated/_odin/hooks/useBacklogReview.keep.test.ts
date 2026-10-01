import { expect, test } from "bun:test";
import { useBacklogReview } from "./useBacklogReview";

const drop = {
	key: "task:1",
	source: "task",
	title: "t",
	verdict: "DROP" as const,
	evidence: "merged",
};

test("Keep turns a DROP into KEEP and survives the next sweep", () => {
	const store = useBacklogReview.getState();
	store.record([drop]);
	useBacklogReview.getState().keep("task:1");
	expect(useBacklogReview.getState().swept[0]?.verdict).toBe("KEEP");
	useBacklogReview.getState().record([drop]);
	expect(useBacklogReview.getState().swept[0]?.verdict).toBe("KEEP");
	// Gone from the sweep, gone from kept.
	useBacklogReview.getState().record([]);
	expect(useBacklogReview.getState().kept).toEqual([]);
});
