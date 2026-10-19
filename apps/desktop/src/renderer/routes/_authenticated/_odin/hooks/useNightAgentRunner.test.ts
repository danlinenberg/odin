import { describe, expect, test } from "bun:test";
import { nightWindow } from "./useNightAgentRunner";

const at = (iso: string) => new Date(iso);
const secs = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

describe("nightWindow", () => {
	test("before the window: tonight's, across midnight", () => {
		expect(nightWindow(at("2026-10-19T18:00:00"), "23:00", "07:00")).toEqual({
			from: secs("2026-10-19T23:00:00"),
			to: secs("2026-10-20T07:00:00"),
		});
	});

	test("after midnight inside it: the one that started yesterday", () => {
		expect(nightWindow(at("2026-10-20T02:00:00"), "23:00", "07:00")).toEqual({
			from: secs("2026-10-19T23:00:00"),
			to: secs("2026-10-20T07:00:00"),
		});
	});

	test("a window within one day, already over: tomorrow's", () => {
		expect(nightWindow(at("2026-10-19T16:00:00"), "09:00", "12:00")).toEqual({
			from: secs("2026-10-20T09:00:00"),
			to: secs("2026-10-20T12:00:00"),
		});
	});
});
