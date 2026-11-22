/**
 * The ids of the things a session worked on - a design file and the frame in
 * it, an email campaign, a doc - so a page you have open can find the sessions
 * that touched it. A web app's URL carries the id of what it shows, and the
 * MCP calls a session made carry the same id as an input (a design tool's
 * `fileKey` and `nodeId`, a campaign's `id`). Matching the two needs no
 * knowledge of any one app.
 */

/** A key that names an id: `id`, `ids`, `campaign_id`, `file_key`, `nodeId`,
 *  `fileKey`, `issueIdOrKey`, a chat message's `message_ts`, `pull_number`,
 *  `ID` - not `width`, `provider` or `line_number`. */
const ID_KEY =
	/(?:^|[_-])(?:ids?|key|ts)$|[a-z](?:Ids?|Key|Ts)$|ID$|(?:pull|issue|pr)_?[Nn]umber$/;

const URL_IN_TEXT = /https?:\/\/[^\s"'<>`)\]]+/g;

/** Most ids a session keeps: enough for a long session, bounded per digest. */
const MAX_IDS = 5000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One spelling per id, whichever side wrote it:
 * - `2781:25404` (a frame id as an API takes it) is `2781-25404` (as a URL
 *   shows it);
 * - a UUID with dashes (a docs API) is the same 32 hex a page URL ends with;
 * - a chat message's `1795000436.449329` is the URL's `p1795000436449329`.
 */
function normalize(value: string): string {
	const id = value.trim();
	if (UUID.test(id)) return id.replace(/-/g, "").toLowerCase();
	if (/^[0-9a-f]{32}$/i.test(id)) return id.toLowerCase();
	if (/^\d{10}\.\d{6}$/.test(id)) return id.replace(".", "");
	if (/^p\d{16}$/.test(id)) return id.slice(1);
	return id.replace(/:/g, "-");
}

/**
 * Looks like an id rather than a word, a page name or a count: a number of two
 * digits or more, two numbers joined (`2781-25404`), a UUID, an issue key
 * (`ENG-123`), a long document id (25+ chars), or a 6-64 char token mixing
 * letters and digits that isn't a hyphenated slug (`Brand-2026-Launch`).
 */
export function isIdLike(value: string): boolean {
	if (/^\d{2,20}$/.test(value)) return true;
	if (/^\d+-\d+$/.test(value)) return true;
	if (UUID.test(value)) return true;
	if (/^[A-Z][A-Z0-9]+-\d+$/.test(value)) return true;
	// A document id (`1aBc-dEf...`, 44 chars) may put a dash beside letters.
	if (/^[A-Za-z0-9_-]{25,64}$/.test(value) && /\d/.test(value)) return true;
	return (
		/^[A-Za-z0-9_-]{6,64}$/.test(value) &&
		/\d/.test(value) &&
		/[A-Za-z]/.test(value) &&
		!/-[A-Za-z]{2,}|[A-Za-z]{2,}-/.test(value)
	);
}

/**
 * The ids in a URL, outermost first: path segments in order, then query
 * values. The last ones name the most specific thing (the frame in the file,
 * the email in the campaign).
 */
export function idsInUrl(raw: string): string[] {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return [];
	}
	const ids: string[] = [];
	const add = (value: string) => {
		let decoded = value;
		try {
			decoded = decodeURIComponent(value);
		} catch {}
		const id = normalize(decoded);
		if (isIdLike(id) && !ids.includes(id)) ids.push(id);
	};
	for (const segment of url.pathname.split("/")) {
		if (!segment) continue;
		// A page whose id ends a title slug: `Launch-Plan-1a2b...` (32 hex).
		const tail = /(?:^|-)([0-9a-f]{32})$/i.exec(segment);
		add(tail ? (tail[1] as string) : segment);
	}
	for (const [, value] of url.searchParams) add(value);
	return ids;
}

/** Every URL quoted in a piece of text. */
export function urlsIn(text: string): string[] {
	return text.match(URL_IN_TEXT) ?? [];
}

/**
 * The ids a tool call's input names: a value under a key that says it is one
 * (`id`, `fileKey`, `campaign_id`, `nodeId`), and the ids of any URL passed.
 */
export function idsInToolInput(input: unknown, into: Set<string>): void {
	const walk = (value: unknown, key: string, depth: number) => {
		if (into.size >= MAX_IDS || depth > 6) return;
		if (typeof value === "string") {
			for (const url of urlsIn(value))
				for (const id of idsInUrl(url)) into.add(id);
			if (ID_KEY.test(key) && value.length <= 64) {
				const id = normalize(value);
				if (isIdLike(id)) into.add(id);
			}
		} else if (typeof value === "number") {
			if (ID_KEY.test(key) && Number.isInteger(value)) {
				const id = String(value);
				if (isIdLike(id)) into.add(id);
			}
		} else if (Array.isArray(value)) {
			for (const item of value) walk(item, key, depth + 1);
		} else if (value && typeof value === "object") {
			for (const [k, v] of Object.entries(value)) walk(v, k, depth + 1);
		}
	};
	walk(input, "", 0);
}

/** The ids of the URLs in prose (what you typed, what Claude wrote). */
export function idsInText(text: string, into: Set<string>): void {
	for (const url of urlsIn(text)) {
		if (into.size >= MAX_IDS) return;
		for (const id of idsInUrl(url)) into.add(id);
	}
}

/** The URL a query is, when it is one: an asset search instead of keywords. */
export function urlQuery(query: string): string | null {
	const trimmed = query.trim();
	return /^https?:\/\/\S+$/.test(trimmed) ? trimmed : null;
}

/**
 * How a session matches a URL's ids: the depth of the most specific id it
 * touched (1 = the outermost), 0 when it touched none. A session on the frame
 * beats one that only opened the file.
 */
export function assetDepth(urlIds: string[], sessionIds: Set<string>): number {
	for (let i = urlIds.length - 1; i >= 0; i--)
		if (sessionIds.has(urlIds[i] as string)) return i + 1;
	return 0;
}
