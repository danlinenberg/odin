/**
 * The Tasks page's ticked rows. A click ticks or unticks one row; a
 * shift-click sets every row between it and the last one clicked to the same
 * state - cleaning up twenty tickets was twenty clicks on twenty Done buttons.
 */
export function nextSelection(
	selected: ReadonlySet<string>,
	visible: readonly string[],
	key: string,
	shift: boolean,
	anchor: string | null,
): Set<string> {
	const next = new Set(selected);
	const on = !selected.has(key);
	const from = anchor && shift ? visible.indexOf(anchor) : -1;
	const to = visible.indexOf(key);
	const range =
		from >= 0 && to >= 0
			? visible.slice(Math.min(from, to), Math.max(from, to) + 1)
			: [key];
	for (const k of range) {
		if (on) next.add(k);
		else next.delete(k);
	}
	return next;
}

/** Ticks that still point at a row on screen - a filter or a Done drops the rest. */
export function visibleSelection(
	selected: ReadonlySet<string>,
	visible: readonly string[],
): string[] {
	return visible.filter((key) => selected.has(key));
}
