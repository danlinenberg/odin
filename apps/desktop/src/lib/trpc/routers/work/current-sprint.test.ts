import { describe, expect, it } from "bun:test";
import { currentSprint } from "./index";

describe("currentSprint", () => {
	it("picks the active sprint over closed and future ones", () => {
		expect(
			currentSprint([
				{ name: "S40", state: "closed" },
				{ name: "S42", state: "future", startDate: "2026-10-20" },
				{ name: "S41", state: "active", endDate: "2026-10-14" },
			]),
		).toMatchObject({ name: "S41", state: "active", endDate: "2026-10-14" });
	});

	it("falls back to the soonest future sprint", () => {
		expect(
			currentSprint([
				{ name: "Later", state: "future", startDate: "2026-11-03" },
				{ name: "Next", state: "future", startDate: "2026-10-20" },
			]),
		).toMatchObject({ name: "Next", state: "future" });
	});

	it("puts tickets whose sprints all closed, or that have none, in the Backlog", () => {
		expect(currentSprint([{ name: "S39", state: "closed" }])).toBeNull();
		expect(currentSprint(null)).toBeNull();
		expect(currentSprint([])).toBeNull();
	});
});
