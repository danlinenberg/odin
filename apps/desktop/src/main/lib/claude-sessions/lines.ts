/**
 * One pass over a transcript that several readers share: each line is split
 * once and JSON-parsed at most once, however many readers look at it. The
 * board reads nine things off a live session's transcript; each used to split
 * and parse the whole file again.
 */
export interface LineReader {
	/** `entry()` parses the line on first call; undefined when it isn't JSON. */
	line(raw: string, entry: () => unknown): void;
}

export function feedLine(raw: string, readers: LineReader[]): void {
	let parsed = false;
	let value: unknown;
	const entry = () => {
		if (!parsed) {
			parsed = true;
			try {
				value = JSON.parse(raw);
			} catch {
				value = undefined;
			}
		}
		return value;
	};
	for (const reader of readers) reader.line(raw, entry);
}

export function feedLines(jsonl: string, ...readers: LineReader[]): void {
	for (const raw of jsonl.split("\n")) feedLine(raw, readers);
}
