import { expect, test } from "bun:test";
import {
	inOffHours,
	MAX_NIGHT_PICKS,
	toggleNightPick,
	useNextInLinePrompt,
} from "./next-in-line-prompt";

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

test("night picks toggle, and stop at the cap", () => {
	const picks = () => useNextInLinePrompt.getState().offHours.picked;
	toggleNightPick("a");
	toggleNightPick("b");
	toggleNightPick("a");
	expect(picks()).toEqual(["b"]);
	for (let i = 0; i < MAX_NIGHT_PICKS + 5; i++) toggleNightPick(`k${i}`);
	expect(picks().length).toBe(MAX_NIGHT_PICKS);
});
