import crypto from "node:crypto";

/** The header a remote host's service sends on every request through the tunnel. */
export const TUNNEL_HEADER = "x-odin-tunnel";

/** Whether `given` is the tunnel secret, in constant time. */
export function tunnelSecretMatches(
	given: string | string[] | undefined,
	secret: string,
): boolean {
	if (typeof given !== "string" || !secret) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(secret);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}
