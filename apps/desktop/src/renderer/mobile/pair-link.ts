/**
 * What the QR code in Odin's Settings carries (docs/phone-encryption.md):
 * `odin://pair?k=<Odin's public key>&c=<one-time code>&l=<ws:// on the
 * Wi-Fi>&r=<wss:// relay>`. `link` is the whole link, to tell a new one apart.
 */
export type Pairing = {
	link: string;
	host: string;
	code?: string;
	lan?: string;
	relay?: string;
};

/** The address, or undefined: ws:// only on a local network, wss:// anywhere. */
function socketUrl(value: string | null, local: boolean): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "wss:" || (local && url.protocol === "ws:")
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

export function parsePairLink(input: string): Pairing | null {
	try {
		const link = input.trim();
		const url = new URL(link);
		if (url.protocol !== "odin:") return null;
		const params = url.searchParams;
		const host = params.get("k") ?? "";
		// 32 bytes, base64url.
		if (!/^[A-Za-z0-9_-]{43}$/.test(host)) return null;
		const pairing: Pairing = {
			link,
			host,
			code: params.get("c") ?? undefined,
			lan: socketUrl(params.get("l"), true),
			relay: socketUrl(params.get("r"), false),
		};
		return pairing.lan || pairing.relay ? pairing : null;
	} catch {
		return null;
	}
}
