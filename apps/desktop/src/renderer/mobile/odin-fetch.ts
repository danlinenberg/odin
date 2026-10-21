import {
	connectChannel,
	generateKeyPair,
	type KeyPair,
	keyPairFrom,
	opened,
	relayId,
	websocketPipe,
} from "@odin/channel";
import type { Pairing } from "./pair-link";

/**
 * The app's `fetch` to Odin: each request goes through the end-to-end
 * encrypted channel (packages/odin-channel, docs/phone-encryption.md), on the
 * Wi-Fi first, then through the relay. The phone's private key lives in the
 * iOS Keychain (OdinKeychain.swift), this device only.
 */

type Native = {
	nativePromise?: (
		plugin: string,
		method: string,
		options?: object,
	) => Promise<{ value?: string }>;
};
const native = (window as { Capacitor?: Native }).Capacitor?.nativePromise;

const KEY = "odin-phone-key";

const hex = (bytes: Uint8Array) =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (text: string) =>
	Uint8Array.from(text.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const fromBase64url = (text: string) =>
	Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
		c.charCodeAt(0),
	);

// A browser (bun run dev) keeps the key in localStorage; only the app has a
// Keychain.
const store = {
	get: async () =>
		native
			? (await native("OdinKeychain", "get", { key: KEY })).value
			: (localStorage.getItem(KEY) ?? undefined),
	set: (value: string) =>
		native
			? native("OdinKeychain", "set", { key: KEY, value })
			: Promise.resolve(localStorage.setItem(KEY, value)),
};

let phoneKey: Promise<KeyPair> | null = null;
/** This phone's long-term key: made on first use, then read back. */
function myKey(): Promise<KeyPair> {
	phoneKey ??= (async () => {
		const stored = await store.get();
		if (stored?.length === 64) return keyPairFrom(fromHex(stored));
		const pair = generateKeyPair();
		await store.set(hex(pair.privateKey));
		return pair;
	})();
	return phoneKey;
}

/** Odin closed the handshake: this phone isn't on its list (any more). */
export class Unpaired extends Error {}

type Channel = Awaited<ReturnType<typeof connectChannel>>;

/** One path: open the socket, then the handshake. The Wi-Fi answers at
 * once or not at all, so it gets less time than the relay. */
async function attempt(
	url: string,
	pairing: Pairing,
	limitMs: number,
): Promise<Channel> {
	const me = await myKey();
	const socket = new WebSocket(url);
	socket.binaryType = "arraybuffer";
	let code = 0;
	let wasOpen = false;
	let timedOut = false;
	socket.addEventListener("close", (event) => {
		code = event.code;
	});
	const timer = setTimeout(() => {
		timedOut = true;
		socket.close();
	}, limitMs);
	try {
		await opened(socket);
		wasOpen = true;
		return await connectChannel(websocketPipe(socket), {
			me,
			host: fromBase64url(pairing.host),
			hello: { v: 1, code: pairing.code },
		});
	} catch (error) {
		// It connected, and the other end hung up on the handshake: that's Odin
		// saying no. A relay without our Odin closes with 4404/4408 instead.
		if (wasOpen && !timedOut && ![4404, 4408, 1006].includes(code))
			throw new Unpaired("This phone is no longer paired");
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

let channel: Promise<Channel> | null = null;
/** The path that worked last: tried first next time. */
let lastUrl: string | null = null;

/** The open channel, or a new one: the Wi-Fi first, then the relay. */
function connect(pairing: Pairing): Promise<Channel> {
	channel ??= (async () => {
		const paths = [
			pairing.lan,
			pairing.relay &&
				`${pairing.relay}/connect/${relayId(fromBase64url(pairing.host))}`,
		]
			.filter((url): url is string => !!url)
			.sort((a, b) => Number(b === lastUrl) - Number(a === lastUrl));
		let last: unknown = new Error("No address to reach Odin");
		for (const url of paths) {
			try {
				const open = await attempt(
					url,
					pairing,
					url === pairing.lan ? 1_500 : 8_000,
				);
				lastUrl = url;
				void open.closed.then(() => {
					channel = null;
				});
				return open;
			} catch (error) {
				if (error instanceof Unpaired) throw error;
				last = error;
			}
		}
		throw last;
	})();
	return channel.catch((error) => {
		channel = null;
		throw error;
	});
}

/**
 * A socket can die without closing - the phone slept, the app went to the
 * background, the network changed - and every request on it then waits
 * forever. Drop it, so the next request opens a fresh one.
 */
function drop() {
	const old = channel;
	channel = null;
	void old?.then((open) => open.close()).catch(() => {});
}

// Coming back to the app: the socket from before is likely dead.
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") drop();
});

/** Longest a request waits for Odin before the socket counts as dead. */
const ANSWER_MS = 12_000;

/** What the app calls Odin with: tRPC's link and the upload. */
export type OdinFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

/** A `fetch` for "/trpc/..." and "/upload?...", through the channel. */
export function channelFetch(pairing: Pairing): OdinFetch {
	return async (input, init) => {
		const url = new URL(
			input instanceof Request ? input.url : input,
			"http://odin",
		);
		const headers = new Headers(init?.headers);
		const body = new Uint8Array(
			await new Response(init?.body ?? null).arrayBuffer(),
		);
		let open: Channel;
		try {
			open = await connect(pairing);
		} catch (error) {
			// tRPC and the upload read a 401 as "pair again".
			if (error instanceof Unpaired) return new Response(null, { status: 401 });
			throw new TypeError(
				error instanceof Error ? error.message : "Couldn't reach Odin",
			);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		// An upload can take longer than a poll: it gets its own limit.
		const limit = url.pathname.startsWith("/upload") ? 120_000 : ANSWER_MS;
		const answer = await Promise.race([
			open.request({
				method: init?.method ?? "GET",
				path: url.pathname + url.search,
				headers: headers.has("content-type")
					? { "content-type": headers.get("content-type") as string }
					: {},
				body,
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					drop();
					reject(new TypeError("Odin didn't answer. Reconnecting."));
				}, limit);
			}),
		]).finally(() => clearTimeout(timer));
		return new Response(answer.status === 204 ? null : answer.body.slice(), {
			status: answer.status,
			headers: answer.headers,
		});
	};
}
