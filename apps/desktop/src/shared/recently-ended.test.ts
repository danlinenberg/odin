import { expect, test } from "bun:test";
import { RECENTLY_ENDED_MS, recentlyEnded } from "./recently-ended";

test("counts turns that ended in the last hour and still wait on you, newest first", () => {
	const now = 10 * RECENTLY_ENDED_MS;
	const rows = recentlyEnded(
		[
			{ id: "old", column: "review", statusAt: now - RECENTLY_ENDED_MS },
			{ id: "asks", column: "permission", statusAt: now - 5_000 },
			{ id: "done", column: "review", statusAt: now - 60_000 },
			{ id: "answered", column: "working", statusAt: now - 1_000 },
			{ id: "idle", column: "idle", statusAt: now - 1_000 },
			{ id: "unknown", column: "review", statusAt: null },
		],
		now,
	);
	expect(rows.map((r) => r.id)).toEqual(["asks", "done"]);
});
