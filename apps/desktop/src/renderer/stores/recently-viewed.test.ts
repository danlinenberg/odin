import { expect, test } from "bun:test";
import { rememberView } from "./recently-viewed";

test("a view stamps the pane, newest first", () => {
	const viewed = rememberView(rememberView({}, "a", 1), "b", 2);
	expect(Object.keys(viewed)).toEqual(["b", "a"]);
	expect(rememberView(viewed, "a", 3)).toEqual({ a: 3, b: 2 });
});

test("keeps the newest 20, and nothing older than two weeks", () => {
	let viewed: Record<string, number> = {};
	for (let i = 0; i < 25; i++) viewed = rememberView(viewed, `p${i}`, i);
	expect(Object.keys(viewed)).toHaveLength(20);
	expect(viewed.p0).toBeUndefined();
	expect(rememberView(viewed, "new", 15 * 86_400_000)).toEqual({
		new: 15 * 86_400_000,
	});
});
