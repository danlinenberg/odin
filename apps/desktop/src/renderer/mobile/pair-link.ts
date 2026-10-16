export type Pairing = { base: string; token: string };

/** `odin://pair?u=http://mac.local:4747/?t=…`, or the http URL itself. */
export function parsePairLink(link: string): Pairing | null {
	try {
		const url = new URL(link.trim());
		const web = url.protocol === "odin:" ? url.searchParams.get("u") : link;
		if (!web) return null;
		const page = new URL(web.trim());
		const token = page.searchParams.get("t");
		return page.protocol === "http:" && token
			? { base: page.origin, token }
			: null;
	} catch {
		return null;
	}
}
