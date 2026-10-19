/**
 * Where a fixed menu's top goes so all of it stays on screen: at the click,
 * moved up when its bottom would pass the window, never above the margin.
 * Measured height, not a guess: the card menu grows when Tags opens, and a
 * fixed allowance left its last rows below the window with no way to reach
 * them.
 */
export function menuTop(
	y: number,
	height: number,
	viewportHeight: number,
	margin = 8,
): number {
	return Math.max(margin, Math.min(y, viewportHeight - height - margin));
}
