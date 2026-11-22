import {
	connectChannel,
	generateKeyPair,
	type KeyPair,
	keyPairFrom,
	opened,
	relayId,
	websocketPipe,
} from "@odin/channel";
import superjson from "superjson";
import { setConnectStep } from "./connect-step";
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

/** Who a pairing reaches, for the spinner's steps: the Mac, or the remote host by name. */
const who = (pairing: Pairing) => pairing.remoteHost ?? "Your Mac";

/** Odin closed the handshake: this phone isn't on its list (any more). */
export class Unpaired extends Error {}

type Channel = Awaited<ReturnType<typeof connectChannel>>;

/** One path: open the socket, then the handshake. The Wi-Fi answers at
 * once or not at all, so it gets less time than the relay. `quiet` leaves
 * the spinner's step alone: a look for the Mac behind the host's answers. */
async function attempt(
	url: string,
	pairing: Pairing,
	limitMs: number,
	quiet: boolean,
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
		if (!quiet) setConnectStep(`${who(pairing)} is checking this phone`);
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

/** Longest a poll waits for Odin before it gives up on the answer. */
const ANSWER_MS = 12_000;

/**
 * Calls that are slow by nature: the brief runs `claude -p`, a reply copies
 * its files to a remote host, a Run or a menu answer types into the
 * terminal step by step. And the upload.
 */
const SLOW_RE =
	/^\/(upload|trpc\/(brief|links|screens|search|reply|run|keys|add|start|interrupt|done)\b)/;

/** What the app calls Odin with: tRPC's link and the upload. */
export type OdinFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

/** Odin couldn't be reached at all: nothing was sent. */
export class Unreachable extends TypeError {}

/** The request went out on a socket that then said nothing at all: likely dead. */
export class Silent extends TypeError {}

/**
 * A channel's `fetch`, and `reach`: opens the channel without asking it
 * anything, so a caller learns whether Odin is there before it sends.
 */
export type ChannelFetch = OdinFetch & {
	reach?: (quiet?: boolean) => Promise<void>;
};

/** How long the relay path waits for a later start, so the Wi-Fi wins when it's there. */
const RELAY_HEAD_START_MS = 300;

/** A `fetch` for "/trpc/..." and "/upload?...", through one pairing's channel. */
export function channelFetch(pairing: Pairing): ChannelFetch {
	let channel: Promise<Channel> | null = null;
	/** The path that worked last: tried first next time. */
	let lastUrl: string | null = null;
	/** When the open channel last answered anything: a live one answers the polls. */
	let heardAt = 0;

	/**
	 * The open channel, or a new one: the path that worked last, and a moment
	 * later the other beside it, so a Wi-Fi the Mac isn't on costs no wait
	 * before the relay is tried. The first to open is kept.
	 */
	function connect(quiet = false): Promise<Channel> {
		channel ??= (async () => {
			const paths = [
				pairing.lan,
				pairing.relay &&
					`${pairing.relay}/connect/${relayId(fromBase64url(pairing.host))}`,
			]
				.filter((url): url is string => !!url)
				.sort((a, b) => Number(b === lastUrl) - Number(a === lastUrl));
			if (!paths.length) throw new Error("No address to reach Odin");
			let won = false;
			const tries = paths.map(async (url, index) => {
				if (index)
					await new Promise((resolve) =>
						setTimeout(resolve, RELAY_HEAD_START_MS),
					);
				if (won) throw new Error("Another path opened first");
				if (!quiet)
					setConnectStep(
						url === pairing.lan
							? `Reaching ${who(pairing)} on this Wi-Fi`
							: `Reaching ${who(pairing)} through the relay`,
					);
				const open = await attempt(
					url,
					pairing,
					url === pairing.lan ? 1_500 : 8_000,
					quiet,
				);
				// The other path opened first: this one isn't needed.
				if (won) {
					open.close();
					throw new Error("Another path opened first");
				}
				won = true;
				lastUrl = url;
				return open;
			});
			try {
				const open = await Promise.any(tries);
				void open.closed.then(() => {
					channel = null;
				});
				return open;
			} catch (error) {
				const errors = (error as AggregateError).errors ?? [error];
				// Odin saying no on one path is its answer on both.
				throw errors.find((e) => e instanceof Unpaired) ?? errors.at(-1);
			}
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

	const send: ChannelFetch = async (input, init) => {
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
			open = await connect();
		} catch (error) {
			setConnectStep(null);
			// tRPC and the upload read a 401 as "pair again".
			if (error instanceof Unpaired) return new Response(null, { status: 401 });
			throw new Unreachable(
				error instanceof Error ? error.message : "Couldn't reach Odin",
			);
		}
		const slow = SLOW_RE.test(url.pathname);
		// A slow call says nothing: the board's spinner is about the board.
		if (!slow) setConnectStep(`Waiting for ${who(pairing)} to answer`);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const limit = slow ? 120_000 : ANSWER_MS;
		const asked = Date.now();
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
					// Other answers came in meanwhile: the socket lives and this
					// call is just slow. Dropping it then failed every poll with it.
					if (heardAt > asked) {
						reject(new TypeError("Odin is slow to answer."));
						return;
					}
					drop();
					reject(new Silent("Odin didn't answer. Reconnecting."));
				}, limit);
			}),
		])
			.catch((error) => {
				setConnectStep(null);
				throw error;
			})
			.finally(() => clearTimeout(timer));
		heardAt = Date.now();
		setConnectStep(null);
		return new Response(answer.status === 204 ? null : answer.body.slice(), {
			status: answer.status,
			headers: answer.headers,
		});
	};
	send.reach = async (quiet = false) => {
		try {
			await connect(quiet);
		} finally {
			if (!quiet) setConnectStep(null);
		}
	};
	return send;
}

/** What a remote host's phone server answers (main/lib/phone/host/router.ts). */
const ON_HOST = new Set([
	"board",
	"session",
	"reply",
	"brief",
	"links",
	"dismissed",
	"profiles",
	"host",
	"repos",
	"screens",
	// A task the Mac left there or the host fetched, a new one typed on the
	// phone, and Done on a session or task there (Tasks with the Mac closed).
	"start",
	"add",
	"done",
	"drop",
	// Kept on the host and put on the Mac's board when it is back.
	"star",
]);

/** The procedures a "/trpc/a,b?batch=1" path calls, or null for anything else. */
const procedures = (path: string) =>
	path.match(/^\/trpc\/([^?]+)/)?.[1]?.split(",") ?? null;

/**
 * Whether the remote host answers this path: every procedure it calls, or
 * an upload, which the host keeps for a reply to a session there.
 */
const onHost = (path: string) =>
	path === "/upload" || !!procedures(path)?.every((name) => ON_HOST.has(name));

/** After the Mac was out of reach, how long before the phone looks for it again. */
const AWAY_MS = 15_000;

/** How long a Mac gets to open its channel before the host is asked instead. */
const MAC_GRACE_MS = 2_500;

/**
 * Odin on the Mac first; when it can't be reached at all (asleep, closed,
 * offline), the remote host's phone server for what it answers: the
 * sessions there, their conversations and a reply. Only a Mac that never got
 * the request falls back, so a reply is never typed in twice; a read the Mac
 * got and never answered is asked of the host too, as asking twice is safe.
 * A host that refuses the phone (401) is not the Mac unpairing it:
 * `onHostRefused` forgets the host's link, and the answer says the Mac is away.
 *
 * The wait for the Mac is short. Its channel gets MAC_GRACE_MS to open
 * (`reach`); past that the host answers, while the channel goes on opening
 * behind it. While the Mac is away the host answers at once, and the phone
 * looks for the Mac every AWAY_MS without holding a request for it.
 *
 * `host` is read at each request: with the Mac away the phone can switch to
 * another profile's host.
 */
export function routedFetch(
	mac: ChannelFetch,
	hostNow: () => OdinFetch | null,
	onHostRefused?: () => void,
): OdinFetch {
	const viaHost = async (
		to: OdinFetch,
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const answer = await to(input, init);
		if (answer.status !== 401) return answer;
		onHostRefused?.();
		throw new Unreachable(
			"Your Mac is away, and the remote host doesn't know this phone yet. Open Odin on the Mac once.",
		);
	};
	let away = false;
	let lookAgainAt = 0;
	let looking: Promise<boolean> | null = null;
	/** Opens the Mac's channel; true when it's there. One look at a time. */
	const look = (quiet: boolean): Promise<boolean> => {
		looking ??= (mac.reach as NonNullable<ChannelFetch["reach"]>)(quiet)
			.then(
				() => {
					away = false;
					return true;
				},
				(error) => {
					// Odin saying no is its answer: the request goes to it, and
					// its 401 sends the phone to pair again.
					away = !(error instanceof Unpaired);
					return !away;
				},
			)
			.finally(() => {
				looking = null;
				lookAgainAt = Date.now() + AWAY_MS;
			});
		return looking;
	};
	return async (input, init) => {
		const url = new URL(
			input instanceof Request ? input.url : input,
			"http://odin",
		);
		const to = hostNow();
		const hostCan = !!to && onHost(url.pathname);
		if (hostCan && away) {
			if (mac.reach && Date.now() >= lookAgainAt) void look(true);
			else if (!mac.reach && Date.now() >= lookAgainAt) away = false;
			if (away) return viaHost(to, input, init);
		}
		if (hostCan && mac.reach) {
			const there = await Promise.race([
				look(false),
				new Promise<false>((resolve) =>
					setTimeout(() => resolve(false), MAC_GRACE_MS),
				),
			]);
			if (!there) {
				// Still opening: the look itself says so if the Mac turns up.
				away = true;
				return viaHost(to, input, init);
			}
		}
		try {
			return await mac(input, init);
		} catch (error) {
			const read = (init?.method ?? "GET").toUpperCase() === "GET";
			if (!(error instanceof Unreachable || (read && error instanceof Silent)))
				throw error;
			// With a host paired, "Couldn't connect" says too little: the Mac
			// is away, and this is one of the things only it does.
			if (!hostCan) throw to ? new Unreachable(NEEDS_MAC) : error;
			away = true;
			lookAgainAt = Date.now() + AWAY_MS;
			return viaHost(to, input, init);
		}
	};
}

/** What the phone says for the Night Agent, search or Stop with the Mac away. */
export const NEEDS_MAC =
	"Your Mac is away, and only it can do this. Open Odin on your Mac.";

/**
 * A phone paired with the remote host alone: what the host answers goes to
 * it, and the rest says it needs the Mac, in place of the host's "No
 * procedure found".
 */
export function hostOnlyFetch(host: OdinFetch): OdinFetch {
	return async (input, init) => {
		const url = new URL(
			input instanceof Request ? input.url : input,
			"http://odin",
		);
		if (!onHost(url.pathname))
			throw new Unreachable(
				"This needs Odin on your Mac: this phone is paired with the remote host only.",
			);
		return host(input, init);
	};
}

/** The session a request is about: an upload's `pane`, or the first paneId in its input. */
async function paneOf(url: URL, init?: RequestInit): Promise<string | null> {
	const pane = url.searchParams.get("pane");
	if (pane) return pane;
	const text =
		url.searchParams.get("input") ??
		(typeof init?.body === "string" ? init.body : "");
	const match = text.match(/"paneId":("(?:[^"\\]|\\.)*")/);
	try {
		return match ? (JSON.parse(match[1] as string) as string) : null;
	} catch {
		return null;
	}
}

type HostBoard = { sessions: { paneId: string }[] };

/** How long the hosts' last boards say where sessions run, before an unknown one asks again. */
const LEARN_MS = 10_000;

/**
 * With the Mac away and a cluster of remote hosts: each host's phone server
 * knows only the sessions on it. The board asks every host and lists all
 * their sessions; a call about one session, or an upload for it, goes to the
 * host it runs on. The rest (the backlog, a new task) is the main host's. A
 * cluster host that doesn't answer leaves its sessions off the board.
 */
export function clusterFetch(main: OdinFetch, others: OdinFetch[]): OdinFetch {
	if (!others.length) return main;
	const owner = new Map<string, OdinFetch>();
	let learnedAt = 0;
	const othersSessions = async () => {
		const boards = await Promise.allSettled(
			others.map(async (to) => {
				const answer = await to("/trpc/board");
				if (!answer.ok) throw new Error(`board ${answer.status}`);
				const body = await answer.json();
				return {
					to,
					board: superjson.deserialize<HostBoard>(body.result.data),
				};
			}),
		);
		learnedAt = Date.now();
		return boards.flatMap((each) =>
			each.status === "fulfilled"
				? each.value.board.sessions.map((session) => {
						owner.set(session.paneId, each.value.to);
						return session;
					})
				: [],
		);
	};
	return async (input, init) => {
		const url = new URL(
			input instanceof Request ? input.url : input,
			"http://odin",
		);
		const boardAt = (procedures(url.pathname) ?? []).indexOf("board");
		if (boardAt >= 0) {
			const [answer, extra] = await Promise.all([
				main(input, init),
				othersSessions(),
			]);
			if (!answer.ok || !extra.length) return answer;
			const body = await answer.json();
			const entry = Array.isArray(body) ? body[boardAt] : body;
			if (entry?.result?.data) {
				const board = superjson.deserialize<HostBoard>(entry.result.data);
				for (const session of board.sessions) owner.set(session.paneId, main);
				const seen = new Set(board.sessions.map((session) => session.paneId));
				board.sessions.push(...extra.filter((s) => !seen.has(s.paneId)));
				entry.result.data = superjson.serialize(board);
			}
			return new Response(JSON.stringify(body), {
				status: answer.status,
				headers: answer.headers,
			});
		}
		const paneId = await paneOf(url, init);
		if (!paneId) return main(input, init);
		if (!owner.has(paneId) && Date.now() - learnedAt > LEARN_MS)
			await othersSessions();
		const to = owner.get(paneId) ?? main;
		const answer = await to(input, init);
		// Not the main host refusing: its link stays.
		if (answer.status === 401 && to !== main)
			throw new Unreachable(
				"Your Mac is away, and the remote host this session runs on doesn't know this phone yet. Open Odin on the Mac once.",
			);
		return answer;
	};
}
