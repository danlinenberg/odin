// Find in the open conversation: the matching, kept apart from the DOM so it
// can be tested, and the DOM walk that turns matches into Ranges.

/** Where `query` occurs in `text`, ignoring case: [start, end) pairs, no overlaps. */
export function matchSpans(text: string, query: string): [number, number][] {
	const needle = query.toLowerCase();
	const hay = text.toLowerCase();
	// A letter whose lower case has another length would shift every offset after it.
	if (!needle || hay.length !== text.length) return [];
	const spans: [number, number][] = [];
	for (let at = hay.indexOf(needle); at !== -1; ) {
		spans.push([at, at + needle.length]);
		at = hay.indexOf(needle, at + needle.length);
	}
	return spans;
}

/** The index of the first span that starts at or after `offset`, else 0. */
export function firstFrom(starts: number[], offset: number): number {
	const index = starts.findIndex((start) => start >= offset);
	return index === -1 ? 0 : index;
}

/**
 * Every visible match of `query` in the text under `root`. The text nodes are
 * read as one string, so a match across bold or a link still counts. Text
 * that is not drawn (a collapsed step) is left out.
 */
export function findRanges(root: Node, query: string): Range[] {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	const starts: number[] = [];
	let text = "";
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		nodes.push(node as Text);
		starts.push(text.length);
		text += node.nodeValue ?? "";
	}
	const at = (offset: number, end: boolean): [Text, number] => {
		let i = nodes.length - 1;
		while (i > 0 && (end ? starts[i] >= offset : starts[i] > offset)) i--;
		return [nodes[i], offset - starts[i]];
	};
	const ranges: Range[] = [];
	for (const [from, to] of matchSpans(text, query)) {
		const range = document.createRange();
		range.setStart(...at(from, false));
		range.setEnd(...at(to, true));
		if (range.getClientRects().length > 0) ranges.push(range);
	}
	return ranges;
}
