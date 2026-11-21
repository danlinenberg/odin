/**
 * Next in line's own order, set by dragging a card. It wins over Newest first
 * and the AI's order until you press Sort with AI again (or reset it).
 */

/** `items` in `order`; one not in it yet (arrived since) goes last, in its old place. */
export function applyManualOrder<T extends { key: string }>(
	items: readonly T[],
	order: readonly string[],
): T[] {
	if (order.length === 0) return [...items];
	const place = new Map(order.map((key, i) => [key, i]));
	return items.toSorted(
		(a, b) =>
			(place.get(a.key) ?? order.length) - (place.get(b.key) ?? order.length),
	);
}

/**
 * The order after dragging `active` onto `over` among the cards as shown.
 * Keys the drag didn't see (a card in Tonight or Due) keep their saved place
 * after the shown ones. Only keys still in `known` are kept, so the saved list
 * never outgrows the tasks waiting.
 */
export function movedOrder(
	shown: readonly string[],
	saved: readonly string[],
	active: string,
	over: string,
	known: ReadonlySet<string>,
): string[] {
	const from = shown.indexOf(active);
	const to = shown.indexOf(over);
	const next = [...shown];
	if (from >= 0 && to >= 0 && from !== to) {
		next.splice(from, 1);
		next.splice(to, 0, active);
	}
	const inShown = new Set(next);
	return [...next, ...saved.filter((key) => !inShown.has(key))].filter((key) =>
		known.has(key),
	);
}
