import { expect, test } from "bun:test";
import { stillDone } from "./next-in-line-done";

test("Remind me: done until the reminder's day, then back", () => {
	const mon = new Date(2026, 8, 28, 10).getTime();
	const wed = new Date(2026, 8, 30, 9).getTime();
	expect(stillDone(undefined, undefined, mon)).toBe(false);
	expect(stillDone(mon, undefined, wed)).toBe(true);
	// reminded for Wednesday: done Tuesday, back Wednesday
	expect(stillDone(mon, "2026-09-30", mon + 86_400_000)).toBe(true);
	expect(stillDone(mon, "2026-09-30", wed)).toBe(false);
	// plain Done on something already due stays done
	expect(stillDone(wed, "2026-09-28", wed)).toBe(true);
});
