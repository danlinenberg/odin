import { expect, test } from "bun:test";
import { inOffHours } from "./next-in-line-prompt";

const at = (hhmm: string) => new Date(`2026-10-01T${hhmm}:00`);

test("a window that wraps midnight", () => {
	expect(inOffHours(at("23:30"), "23:00", "07:00")).toBe(true);
	expect(inOffHours(at("03:00"), "23:00", "07:00")).toBe(true);
	expect(inOffHours(at("07:00"), "23:00", "07:00")).toBe(false);
	expect(inOffHours(at("12:00"), "23:00", "07:00")).toBe(false);
});

test("a same-day window", () => {
	expect(inOffHours(at("13:00"), "12:00", "14:00")).toBe(true);
	expect(inOffHours(at("14:00"), "12:00", "14:00")).toBe(false);
	expect(inOffHours(at("11:59"), "12:00", "14:00")).toBe(false);
});
