import { blake2s } from "@noble/hashes/blake2.js";

/**
 * A host's address on a relay: 22 characters of base64url over BLAKE2s of its
 * public key. The relay learns one ID per host - not the key, not a name.
 */
export function relayId(hostPublicKey: Uint8Array): string {
	let binary = "";
	for (const byte of blake2s(hostPublicKey))
		binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "")
		.slice(0, 22);
}

export const RELAY_ID = /^[A-Za-z0-9_-]{22}$/;
