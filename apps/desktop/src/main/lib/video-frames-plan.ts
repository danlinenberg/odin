/** Frames on one contact sheet by default, and the most a request can ask for. */
export const DEFAULT_FRAMES = 16;
export const MAX_FRAMES = 36;
/** The sheet's width: past this an agent's image reader scales it down anyway. */
export const SHEET_WIDTH = 1920;

/**
 * When to grab each frame: `count` evenly spaced times inside [from, to] (the
 * whole video by default), each at the middle of its slice, so the first
 * isn't a black opening frame and the last isn't past the end.
 */
export function frameTimes(
	duration: number,
	count = DEFAULT_FRAMES,
	from = 0,
	to = duration,
): number[] {
	const start = Math.min(Math.max(from, 0), duration);
	const end = Math.min(Math.max(to, start), duration);
	const n = Math.min(Math.max(Math.round(count), 1), MAX_FRAMES);
	const slice = (end - start) / n;
	return Array.from({ length: n }, (_, i) => start + slice * (i + 0.5));
}

/** Columns for `count` frames: a near-square grid. */
export function gridColumns(count: number): number {
	return Math.max(1, Math.ceil(Math.sqrt(count)));
}

/** A frame's label: its time in the video, as m:ss.s. */
export function timeLabel(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = (seconds - m * 60).toFixed(1).padStart(4, "0");
	return `${m}:${s}`;
}
