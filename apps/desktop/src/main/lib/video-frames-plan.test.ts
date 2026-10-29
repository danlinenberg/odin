import { expect, test } from "bun:test";
import {
	DEFAULT_FRAMES,
	frameTimes,
	gridColumns,
	MAX_FRAMES,
	timeLabel,
} from "./video-frames-plan";

test("frameTimes spaces frames evenly, each in the middle of its slice", () => {
	expect(frameTimes(8, 4)).toEqual([1, 3, 5, 7]);
	expect(frameTimes(100)).toHaveLength(DEFAULT_FRAMES);
});

test("frameTimes keeps to the asked range and to the video", () => {
	expect(frameTimes(60, 2, 10, 20)).toEqual([12.5, 17.5]);
	// A range past the end is cut at the end.
	expect(frameTimes(10, 2, 8, 99)).toEqual([8.5, 9.5]);
	// A count past the cap is cut to it; zero still gives one frame.
	expect(frameTimes(10, 500)).toHaveLength(MAX_FRAMES);
	expect(frameTimes(10, 0)).toEqual([5]);
});

test("gridColumns makes a near-square grid", () => {
	expect(gridColumns(1)).toBe(1);
	expect(gridColumns(16)).toBe(4);
	expect(gridColumns(17)).toBe(5);
});

test("timeLabel reads m:ss.s", () => {
	expect(timeLabel(0)).toBe("0:00.0");
	expect(timeLabel(75.25)).toBe("1:15.3");
});
