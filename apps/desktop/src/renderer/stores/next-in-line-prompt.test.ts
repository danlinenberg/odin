import { describe, expect, test } from "bun:test";
import {
	canPickForTonight,
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

test("only rows Next in line holds can be picked for tonight", () => {
	for (const source of ["Tasks", "Slack", "Jira", "GitHub", "Notion"])
		expect(canPickForTonight({ source })).toBe(true);
	expect(canPickForTonight({ source: "Email" })).toBe(false);
	expect(canPickForTonight({ source: "ClickUp" })).toBe(false);
});

describe("logNight", () => {
	test("collapses a repeat of the last line and keeps the newest 300", () => {
		const { logNight } = useNextInLinePrompt.getState();
		useNextInLinePrompt.setState({ nightLog: [] });
		logNight("On battery");
		logNight("On battery");
		expect(useNextInLinePrompt.getState().nightLog).toHaveLength(1);
		for (let i = 0; i < 400; i++) logNight(`line ${i}`);
		const log = useNextInLinePrompt.getState().nightLog;
		expect(log).toHaveLength(300);
		expect(log.at(-1)?.event).toBe("line 399");
	});
});
