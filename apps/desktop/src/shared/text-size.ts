/**
 * Settings → Appearance → Text size: how big Odin draws its own text, apart
 * from the in-app browser. It rides on the window's zoom, so every pixel size
 * in the app scales with it, and the browser divides it back out: GitHub and
 * the rest stay at the zoom ⌘+/⌘- gave them.
 *
 * The window's zoom = ⌘+/⌘- zoom × text size.
 */
export const TEXT_SIZES = [0.9, 1, 1.1, 1.25, 1.5] as const;

export const DEFAULT_TEXT_SIZE = 1;

/** A stored value that is not one of the choices reads as the default. */
export function textSizeOf(stored: unknown): number {
	return TEXT_SIZES.includes(stored as (typeof TEXT_SIZES)[number])
		? (stored as number)
		: DEFAULT_TEXT_SIZE;
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
