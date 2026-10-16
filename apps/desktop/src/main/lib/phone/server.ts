import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { connect } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import express from "express";
import QRCode from "qrcode";
import { env } from "shared/env.shared";
import { ODIN_HOME_DIR } from "../app-environment";
import { phoneRouter } from "./router";

/**
 * Settings → Connections → Phone: Odin on your iPhone, over this Wi-Fi. A
 * server on the LAN serves the mobile app (renderer/mobile) and the phone's
 * own router; every call needs the token the QR code carries. Off until you
 * turn it on.
 */
// ponytail: plain HTTP on the LAN - anyone on the Wi-Fi can read the traffic.
// HTTPS comes with a relay or tunnel.

/** Where the switch and the token live; a test points it at a temp file. */
export const phoneConfig = { file: join(ODIN_HOME_DIR, "phone.json") };
const PREFERRED_PORT = 4747;

type Config = { enabled: boolean; token: string };

export type PhoneStatus =
	| { state: "off" }
	| { state: "error"; error: string }
	/** qr opens the page in Safari; appQr opens the iOS app (apps/mobile) to pair. */
	| { state: "on"; url: string; qr: string; appQr: string };

let server: Server | null = null;
let status: PhoneStatus = { state: "off" };

function readConfig(): Config {
	try {
		return JSON.parse(readFileSync(phoneConfig.file, "utf8")) as Config;
	} catch {
		return { enabled: false, token: "" };
	}
}

// ponytail: the token sits in plain text in ~/.odin (0700), like the old bot token.
const writeConfig = (config: Config) =>
	writeFileSync(phoneConfig.file, JSON.stringify(config), { mode: 0o600 });

const newToken = () => randomBytes(24).toString("base64url");

function sameToken(given: string, token: string): boolean {
	const a = Buffer.from(given);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

const isDev = env.NODE_ENV === "development";
const vite = `127.0.0.1:${env.DESKTOP_VITE_PORT}`;

function createApp(token: string) {
	const app = express();
	app.use("/trpc", (req, res, next) => {
		const given = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
		if (!sameToken(given, token)) return res.status(401).end();
		next();
	});
	app.use("/trpc", createExpressMiddleware({ router: phoneRouter }));
	app.get("/", (req, res) => {
		const query = req.originalUrl.slice(1);
		res.redirect(`/mobile/index.html${query}`);
	});
	if (isDev) {
		// The renderer's Vite server only listens on localhost; this forwards to
		// it, with Host rewritten so Vite's host check lets it through.
		app.use(async (req, res) => {
			try {
				const reply = await fetch(`http://${vite}${req.originalUrl}`);
				res.status(reply.status);
				const type = reply.headers.get("content-type");
				if (type) res.type(type);
				res.send(Buffer.from(await reply.arrayBuffer()));
			} catch {
				res.status(502).send("Odin's dev server isn't up.");
			}
		});
	} else {
		app.use(express.static(join(__dirname, "../renderer")));
	}
	return app;
}

/** Vite's HMR socket, piped through as raw TCP with Host pointed at Vite. */
function forwardUpgrades(http: Server) {
	http.on("upgrade", (req, socket, head) => {
		const upstream = connect(Number(env.DESKTOP_VITE_PORT), "127.0.0.1", () => {
			const headers = Object.entries({ ...req.headers, host: vite })
				.map(([key, value]) => `${key}: ${value}`)
				.join("\r\n");
			upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
			upstream.write(head);
			socket.pipe(upstream).pipe(socket);
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
	});
}

const localName = () => {
	const name = hostname();
	return name.endsWith(".local") ? name : `${name}.local`;
};

async function listen(token: string): Promise<void> {
	const app = createApp(token);
	const bind = (port: number) =>
		new Promise<Server>((resolve, reject) => {
			const http = app.listen(port, "0.0.0.0");
			http.once("listening", () => resolve(http));
			http.once("error", reject);
		});
	// Another Odin (dev beside packaged) may hold the port: take any free one.
	const http = await bind(PREFERRED_PORT).catch(() => bind(0));
	if (isDev) forwardUpgrades(http);
	server = http;
	const address = http.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const url = `http://${localName()}:${port}/?t=${token}`;
	status = {
		state: "on",
		url,
		qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }),
		appQr: await QRCode.toDataURL(`odin://pair?u=${encodeURIComponent(url)}`, {
			margin: 1,
			width: 220,
		}),
	};
}

async function stop(): Promise<void> {
	const http = server;
	server = null;
	status = { state: "off" };
	if (http) await new Promise((resolve) => http.close(resolve));
}

export const phoneStatus = () => status;

export async function setPhoneEnabled(enabled: boolean): Promise<PhoneStatus> {
	const config = readConfig();
	const token = config.token || newToken();
	writeConfig({ enabled, token });
	await stop();
	if (enabled)
		await listen(token).catch((error: Error) => {
			status = { state: "error", error: error.message };
		});
	return status;
}

/** A new token: every paired phone has to scan again. */
export async function resetPhoneToken(): Promise<PhoneStatus> {
	writeConfig({ enabled: readConfig().enabled, token: newToken() });
	return setPhoneEnabled(readConfig().enabled);
}

export function startPhone(): void {
	if (readConfig().enabled) void setPhoneEnabled(true);
}
