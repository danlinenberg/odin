import { expect, test } from "bun:test";
import { ticketKey } from "./SessionReminders";

test("ticketKey reads the leading Jira key", () => {
	expect(ticketKey("CRR-917: Add DB field for signup endpoint")).toBe(
		"CRR-917",
	);
	expect(ticketKey(" BUGT2-12 fix")).toBe("BUGT2-12");
	expect(ticketKey("Review Renovate updates")).toBeNull();
	expect(ticketKey("Fix CRR-917")).toBeNull();
});
