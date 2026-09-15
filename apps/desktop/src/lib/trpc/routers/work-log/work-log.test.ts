import { describe, expect, test } from "bun:test";
import { workLogId } from ".";

/**
 * Only the pure half is testable here: test-setup mocks @odin/local-db and
 * main/lib/local-db wholesale (better-sqlite3 doesn't load under bun test), so
 * the upsert itself can't be exercised in this suite.
 *
 * The rule it enforces — a relaunch keeps the original `startedAt` and takes
 * the newer session — lives in the `onConflictDoUpdate` set clause in ./index.
 * Adding `startedAt` to that clause would break the ledger silently, so leave
 * it out.
 */
describe("work log", () => {
	test("id is per source item, so two feeds can't collide on one id", () => {
		expect(workLogId("reactions", "C1:123.45")).toBe("reactions:C1:123.45");
		expect(workLogId("jira", "PROJ-1")).toBe("jira:PROJ-1");
		expect(workLogId("jira", "X")).not.toBe(workLogId("notion", "X"));
	});

	test("the id is stable — a relaunch addresses the same row", () => {
		expect(workLogId("reactions", "C1:123.45")).toBe(
			workLogId("reactions", "C1:123.45"),
		);
	});
});
