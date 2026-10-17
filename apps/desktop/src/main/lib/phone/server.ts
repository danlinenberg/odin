import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import {
	acceptChannel,
	type ChannelRequest,
	type ChannelResponse,
	connectSocket,
	type Pipe,
	relayId,
	websocketPipe,
} from "@odin/channel";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import express from "express";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";
import { ODIN_HOME_DIR } from "../app-environment";
import { attachments } from "./attachments";
import { phoneRouter } from "./router";
import {
	accept,
	type Device,
	devices,
	hostKey,
	identity,
	pairingCode,
	removeDevice,
	resetTrust,
} from "./trust";

/**
 * Settings → Connections → Phone: the iPhone app talks to Odin over an
 * end-to-end encrypted channel (docs/phone-encryption.md, packages/odin-channel):
 * on the Wi-Fi at ws://<mac>.local:<port>/channel, and from anywhere through
 * a relay Odin dials out to. Each request that comes out of the channel goes
 * to the phone's HTTP app, which listens on loopback only. Off until you turn
 * it on.
 */

/** Where the switch and the relay address live; a test points it at a temp file. */
export const phoneConfig = { file: join(ODIN_HOME_DIR, "phone.json") };
const PREFERRED_PORT = 4747;

type Config = { enabled: boolean; relay?: string };

export type RelayState = "connecting" | "connected";

export type PhoneStatus =
	| { state: "off"; relay?: string; devices: Device[] }
	| { state: "error"; error: string; relay?: string; devices: Device[] }
	| {
			state: "on";
			/** Opens the iPhone app and pairs it; the QR code is the same link. */
			link: string;
			qr: string;
			/** The channel's address on this Wi-Fi. */
			lan: string;
			relay?: string;
			relayState?: RelayState;
			devices: Device[];
	  };

type Running = {
	lan: Server;
	loopback: Server;
	lanUrl: string;
	stopRelay: () => void;
};

let running: Running | null = null;
let failure: string | null = null;
let relayState: RelayState = "connecting";
/** Open channels by phone key, so removing a phone cuts it off at once. */
const live = new Map<string, Set<Pipe>>();

function readConfig(): Config {
	try {
		return JSON.parse(readFileSync(phoneConfig.file, "utf8")) as Config;
	} catch {
		return { enabled: false };
	}
}

const writeConfig = (config: Config) =>
	writeFileSync(phoneConfig.file, JSON.stringify(config), { mode: 0o600 });

/** A relay address: wss:// anywhere, or ws:// on this machine for testing. */
export function relayUrl(input: string): string | null {
	try {
		const url = new URL(input.trim());
		const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		if (url.protocol !== "wss:" && !(url.protocol === "ws:" && local))
			return null;
		return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
	} catch {
		return null;
	}
}

function sameToken(given: string, token: string): boolean {
	const a = Buffer.from(given);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** The phone's API. Only the channel reaches it, with a token made per run. */
function createApp(token: string) {
	const app = express();
	const authorized: express.RequestHandler = (req, res, next) => {
		const given = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
		if (!sameToken(given, token)) return res.status(401).end();
		next();
	};
	app.use(
		"/trpc",
		authorized,
		createExpressMiddleware({ router: phoneRouter }),
	);
	// A photo or video from the phone: the raw bytes, saved where the desktop
	// composer saves its own. The reply that follows pastes the returned path.
	app.post(
		"/upload",
		authorized,
		express.raw({ type: () => true, limit: "200mb" }),
		async (req, res) => {
			const ext = String(req.query.ext ?? "").toLowerCase();
			if (!/^[a-z0-9]{1,8}$/.test(ext) || !req.body?.length)
				return res.status(400).end();
			await mkdir(attachments.dir, { recursive: true });
			const name = `${Date.now()}-${randomBytes(3).toString("hex")}.${ext}`;
			const path = join(attachments.dir, name);
			await writeFile(path, req.body);
			res.json({ path });
		},
	);
	return app;
}

const localName = () => {
	const name = hostname();
	return name.endsWith(".local") ? name : `${name}.local`;
};

const portOf = (server: Server) => {
	const address = server.address();
	return typeof address === "object" && address ? address.port : 0;
};

const listenOn = (server: Server, port: number, host: string) =>
	new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => resolve());
	});

const empty = new Uint8Array(0);
const status = (code: number): ChannelResponse => ({
	status: code,
	headers: {},
	body: empty,
});

/** One request out of the channel, to the loopback app. Only its two routes. */
function forward(loopbackPort: number, token: string) {
	return async (request: ChannelRequest): Promise<ChannelResponse> => {
		if (!/^\/(trpc\/|upload\?)/.test(request.path)) return status(404);
		const method = request.method.toUpperCase();
		const response = await fetch(
			`http://127.0.0.1:${loopbackPort}${request.path}`,
			{
				method,
				// Only the content type comes from the phone; the token is ours.
				headers: {
					...(request.headers["content-type"] && {
						"content-type": request.headers["content-type"],
					}),
					authorization: `Bearer ${token}`,
				},
				body:
					method === "GET" || method === "HEAD"
						? undefined
						: request.body.slice(),
			},
		);
		return {
			status: response.status,
			headers: {
				"content-type": response.headers.get("content-type") ?? "",
			},
			body: new Uint8Array(await response.arrayBuffer()),
		};
	};
}

function serve(
	pipe: Pipe,
	handle: (r: ChannelRequest) => Promise<ChannelResponse>,
) {
	acceptChannel(pipe, {
		me: identity(),
		accept: (phone, hello) => {
			if (!accept(phone, hello)) return false;
			const key = Buffer.from(phone).toString("base64url");
			const set = live.get(key) ?? new Set();
			set.add(pipe);
			live.set(key, set);
			pipe.onClose(() => set.delete(pipe));
			return true;
		},
		handle,
	});
}

/** Keeps a control connection open to the relay and answers each phone it announces. */
function dialRelay(
	url: string,
	handle: (r: ChannelRequest) => Promise<ChannelResponse>,
): () => void {
	let stopped = false;
	let control: WebSocket | null = null;
	let delay = 1000;
	const id = relayId(identity().publicKey);
	const connect = () => {
		if (stopped) return;
		relayState = "connecting";
		const socket = new WebSocket(`${url}/host/${id}`);
		control = socket;
		socket.addEventListener("open", () => {
			relayState = "connected";
			delay = 1000;
		});
		socket.addEventListener("message", async (event) => {
			let incoming: unknown;
			try {
				incoming = JSON.parse(String(event.data)).incoming;
			} catch {
				return;
			}
			if (typeof incoming !== "string" || !/^[0-9a-f]{32}$/.test(incoming))
				return;
			const session = await connectSocket(`${url}/accept/${incoming}`).catch(
				() => null,
			);
			if (session) serve(websocketPipe(session), handle);
		});
		socket.addEventListener("close", () => {
			relayState = "connecting";
			if (stopped) return;
			// After sleep or a dropped network: back off, then dial again.
			setTimeout(connect, delay);
			delay = Math.min(delay * 2, 60_000);
		});
	};
	connect();
	return () => {
		stopped = true;
		control?.close();
	};
}

async function start(config: Config): Promise<void> {
	const token = randomBytes(24).toString("base64url");
	const loopback = createServer(createApp(token));
	await listenOn(loopback, 0, "127.0.0.1");
	const handle = forward(portOf(loopback), token);

	// The Wi-Fi side answers one thing: the channel's WebSocket.
	const lan = createServer((_req, res) => res.writeHead(404).end());
	const sockets = new WebSocketServer({ noServer: true, maxPayload: 70_000 });
	lan.on("upgrade", (req, socket, head) => {
		if (req.url !== "/channel") return socket.destroy();
		sockets.handleUpgrade(req, socket, head, (ws) =>
			serve(websocketPipe(ws as unknown as WebSocket), handle),
		);
	});
	// Another Odin (dev beside packaged) may hold the port: take any free one.
	await listenOn(lan, PREFERRED_PORT, "0.0.0.0").catch(() =>
		listenOn(lan, 0, "0.0.0.0"),
	);
	running = {
		lan,
		loopback,
		lanUrl: `ws://${localName()}:${portOf(lan)}/channel`,
		stopRelay: config.relay ? dialRelay(config.relay, handle) : () => {},
	};
}

async function stop(): Promise<void> {
	const was = running;
	running = null;
	if (!was) return;
	was.stopRelay();
	for (const set of live.values()) for (const pipe of set) pipe.close();
	live.clear();
	was.lan.closeAllConnections();
	await Promise.all(
		[was.lan, was.loopback].map(
			(server) => new Promise((resolve) => server.close(resolve)),
		),
	);
}

export async function phoneStatus(): Promise<PhoneStatus> {
	const { relay } = readConfig();
	const list = devices();
	if (failure) return { state: "error", error: failure, relay, devices: list };
	if (!running) return { state: "off", relay, devices: list };
	const params = new URLSearchParams({
		k: hostKey(),
		c: pairingCode(),
		l: running.lanUrl,
	});
	if (relay) params.set("r", relay);
	const link = `odin://pair?${params}`;
	return {
		state: "on",
		link,
		qr: await QRCode.toDataURL(link, { margin: 1, width: 220 }),
		lan: running.lanUrl,
		relay,
		relayState: relay ? relayState : undefined,
		devices: list,
	};
}

async function restart(config: Config): Promise<PhoneStatus> {
	writeConfig(config);
	await stop();
	failure = null;
	if (config.enabled)
		await start(config).catch((error: Error) => {
			failure = error.message;
		});
	return phoneStatus();
}

export const setPhoneEnabled = (enabled: boolean) =>
	restart({ ...readConfig(), enabled });

/** The relay's address, or "" for none. Throws on one that isn't wss://. */
export async function setPhoneRelay(input: string): Promise<PhoneStatus> {
	const relay = input.trim() ? relayUrl(input) : undefined;
	if (relay === null)
		throw new Error("The relay address must start with wss://");
	return restart({ ...readConfig(), relay });
}

/** Cuts a phone off: off the list, and its open channels closed. */
export async function removePhone(key: string): Promise<PhoneStatus> {
	removeDevice(key);
	for (const pipe of live.get(key) ?? []) pipe.close();
	live.delete(key);
	return phoneStatus();
}

/** Unpairs every phone: a new key for Odin, so old QR codes are useless too. */
export async function unpairAllPhones(): Promise<PhoneStatus> {
	await stop();
	await resetTrust();
	return restart(readConfig());
}

export function startPhone(): void {
	if (readConfig().enabled) void setPhoneEnabled(true);
}
