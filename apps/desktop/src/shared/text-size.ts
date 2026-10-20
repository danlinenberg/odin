/**
 * Settings → Appearance → Text size: how big Odin draws its own text, apart
 * from the in-app browser. It rides on the window's zoom, so every pixel size
 * in the app scales with it, and the browser divides it back out: GitHub and
 * the rest stay at the zoom ⌘+/⌘- gave them.
 *
 * The window's zoom = ⌘+/⌘- zoom × text size.
 *
 * The setting is a slider from TEXT_SIZE_MIN to TEXT_SIZE_MAX in steps of
 * TEXT_SIZE_STEP (90% to 150%, 5% apart).
 */
export const TEXT_SIZE_MIN = 0.9;
export const TEXT_SIZE_MAX = 1.5;
export const TEXT_SIZE_STEP = 0.05;

export const DEFAULT_TEXT_SIZE = 1;

/** A text size in whole percent: 1.05 is 105. The slider works in these, and
 * so does the snapping, so a step reads back as 1.05 and not 1.0500000000000003. */
export function textSizePercent(size: number): number {
	return Math.round(size * 100);
}

/** A stored value snapped to the slider's steps; one off the slider reads as
 * the default. */
export function textSizeOf(stored: unknown): number {
	if (typeof stored !== "number" || !Number.isFinite(stored)) {
		return DEFAULT_TEXT_SIZE;
	}
	const step = textSizePercent(TEXT_SIZE_STEP);
	const percent = Math.round(textSizePercent(stored) / step) * step;
	if (
		percent < textSizePercent(TEXT_SIZE_MIN) ||
		percent > textSizePercent(TEXT_SIZE_MAX)
	) {
		return DEFAULT_TEXT_SIZE;
	}
	return percent / 100;
}

/** The window's zoom once the text size goes from `from` to `to`. Electron
 * takes 25%-500%. */
export function windowZoomFor(current: number, from: number, to: number) {
	return Math.min(Math.max((current / from) * to, 0.25), 5);
}

/** The in-app browser's zoom: the window's, without the text size. */
export function browserZoomFor(windowZoom: number, textSize: number) {
	return windowZoom / textSize;
}
