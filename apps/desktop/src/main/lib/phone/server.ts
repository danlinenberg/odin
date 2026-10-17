import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import express from "express";
import QRCode from "qrcode";
import { ODIN_HOME_DIR } from "../app-environment";
import { attachments } from "./attachments";
import { phoneRouter } from "./router";

/**
 * Settings → Connections → Phone: the iPhone app (apps/mobile) talks to Odin
 * over this Wi-Fi. A server on the LAN answers the phone's own router and
 * takes its uploads; every call needs the token the QR code carries. Off
 * until you turn it on.
 */
// HTTPS comes with a relay or tunnel.

/** Where the switch and the token live; a test points it at a temp file. */
export const phoneConfig = { file: join(ODIN_HOME_DIR, "phone.json") };
const PREFERRED_PORT = 4747;

type Config = { enabled: boolean; token: string };

export type PhoneStatus =
	| { state: "off" }
	| { state: "error"; error: string }
	/** qr opens the iPhone app and pairs it; url is the same link, to paste. */
	| { state: "on"; url: string; qr: string };

let server: Server | null = null;
let status: PhoneStatus = { state: "off" };

function readConfig(): Config {
	try {
		return JSON.parse(readFileSync(phoneConfig.file, "utf8")) as Config;
	} catch {
		return { enabled: false, token: "" };
	}
}

const writeConfig = (config: Config) =>
	writeFileSync(phoneConfig.file, JSON.stringify(config), { mode: 0o600 });

const newToken = () => randomBytes(24).toString("base64url");

function sameToken(given: string, token: string): boolean {
	const a = Buffer.from(given);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

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
	server = http;
	const address = http.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const url = `http://${localName()}:${port}/?t=${token}`;
	status = {
		state: "on",
		url,
		qr: await QRCode.toDataURL(`odin://pair?u=${encodeURIComponent(url)}`, {
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
