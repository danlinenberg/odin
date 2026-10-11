import { expect, test } from "bun:test";
import { moveKey, typeOf } from "./task-meta";

test("moveKey drops the dragged key where the target was", () => {
	expect(moveKey(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
	expect(moveKey(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
	expect(moveKey(["a", "b"], "x", "a")).toEqual(["a", "b"]);
});

test("a PR reads as a review until you pick a type", () => {
	expect(typeOf({ key: "pr:1", source: "GitHub" }, {})).toBe("review");
	expect(typeOf({ key: "pr:1", source: "GitHub" }, { "pr:1": "read" })).toBe(
		"read",
	);
	expect(typeOf({ key: "task:1", source: "Tasks" }, {})).toBeUndefined();
});
