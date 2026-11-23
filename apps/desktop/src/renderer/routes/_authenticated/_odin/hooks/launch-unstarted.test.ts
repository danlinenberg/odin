import { expect, test } from "bun:test";
import { launchUnstarted } from "./launch-unstarted";

test("a task another caller started while the loop ran gets no second session", async () => {
	const open = new Set<string>();
	const launches: string[] = [];
	// Auto-start takes "b" while "a" is still launching.
	const launched = await launchUnstarted(
		["a", "b", "c"],
		(task) => open.has(task),
		async (task) => {
			launches.push(task);
			open.add(task);
			if (task === "a") open.add("b");
		},
	);
	expect(launches).toEqual(["a", "c"]);
	expect(launched).toEqual(["a", "c"]);
});
