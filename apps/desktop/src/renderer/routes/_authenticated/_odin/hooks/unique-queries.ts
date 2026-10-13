/**
 * One entry per distinct query key, for useQueries. Two entries with the same
 * key - two panes on one conversation, or two cards that link no PR (both ask
 * for `{ urls: [] }`) - make react-query warn "Duplicate Queries found" on
 * every render. `slot[i]` is where item i's answer sits among `unique`.
 */
export function uniqueQueries<T>(
	items: T[],
	keyOf: (item: T) => string,
): { unique: T[]; slot: number[] } {
	const slotByKey = new Map<string, number>();
	const unique: T[] = [];
	const slot = items.map((item) => {
		const key = keyOf(item);
		let at = slotByKey.get(key);
		if (at === undefined) {
			at = unique.length;
			slotByKey.set(key, at);
			unique.push(item);
		}
		return at;
	});
	return { unique, slot };
}
