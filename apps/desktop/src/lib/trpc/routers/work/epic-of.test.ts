import { expect, it } from "bun:test";
import { epicOf } from ".";

it("takes an epic parent, not a story parent or none", () => {
	const parent = (name: string, hierarchyLevel: number) => ({
		key: "RND-1",
		fields: { summary: "Studio", issuetype: { name, hierarchyLevel } },
	});
	expect(epicOf(parent("Epic", 1))).toEqual({ key: "RND-1", title: "Studio" });
	expect(epicOf(parent("Initiative", 1))).toEqual({
		key: "RND-1",
		title: "Studio",
	});
	expect(epicOf(parent("Story", 0))).toBeNull();
	expect(epicOf(undefined)).toBeNull();
});
