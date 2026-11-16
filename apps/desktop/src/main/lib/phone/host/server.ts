import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ChannelRequest,
	type ChannelResponse,
	relayId,
} from "@odin/channel";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { dialRelay, type Handler, serveChannel } from "../channel-host";
import { createTrust } from "../trust";
import { hostPhoneRouter } from "./router";
import { hostPaths } from "./sessions";

/**
 * The phone server on a remote host (docs/phone-encryption.md, "the same
 * code ... on an EC2"): it runs as the Odin user's own Linux user, keeps its
 * own key in ~/.odin/phone-host (mode 0600), dials the same relay as Odin
 * on the laptop, and answers only phones paired with it in person - through
 * a pairing link the laptop's Odin asks it for (`link`) and shows as a QR
 * code. So the phone reaches the sessions here with the laptop shut.
 */

/** What the laptop's Odin writes here: the relay, and the host's name in the link. */
export type HostConfig = { relay?: string; name?: string };

export function hostFiles() {
	const dir = hostPaths.dir;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return {
		identity: join(dir, "identity"),
		devices: join(dir, "devices.json"),
		/** The phones paired with the laptop's Odin, which it writes here at each sync. */
		shared: join(dir, "laptop-devices.json"),
		code: join(dir, "code.json"),
		config: join(dir, "config.json"),
		pid: join(dir, "server.pid"),
	};
}

export const hostTrust = () => createTrust(hostFiles());

export function readHostConfig(): HostConfig {
	try {
		return JSON.parse(readFileSync(hostFiles().config, "utf8"));
	} catch {
		return {};
	}
}

/**
 * The link the phone pairs with: this host's key, a live one-time code and
 * the relay; `h` names the host, which tells the phone this pairing is a
 * remote host's and not Odin on a Mac. No `l`: a phone never shares a
 * network with an EC2.
 */
export function pairingLink(trust = hostTrust(), config = readHostConfig()) {
	return link(trust, config, trust.pairingCode());
}

/**
 * The same link without a code: what the laptop's Odin hands a phone already
 * paired with it. The phone is in through the laptop's list (`shared`), so it
 * needs no code here.
 */
export function hostLink(trust = hostTrust(), config = readHostConfig()) {
	return link(trust, config);
}

function link(
	trust: ReturnType<typeof hostTrust>,
	config: HostConfig,
	code?: string,
) {
	if (!config.relay) throw new Error("No relay set for the phone server");
	const params = new URLSearchParams({ k: trust.hostKey() });
	if (code) params.set("c", code);
	params.set("r", config.relay);
	params.set("h", config.name || "Remote host");
	return `odin://pair?${params}`;
}

const empty = new Uint8Array(0);

/** The most one photo or file from the phone may weigh, as on the laptop. */
const UPLOAD_MAX = 200 * 1024 * 1024;

/**
 * A photo or file from the phone with the laptop away: the raw bytes, kept
 * in ~/.odin/attachments here (only this user reads it). The reply that
 * follows names the returned path, which a session on this host opens.
 */
function upload(request: ChannelRequest): ChannelResponse {
	const ext = (
		new URL(`http://odin${request.path}`).searchParams.get("ext") ?? ""
	).toLowerCase();
	if (
		request.method.toUpperCase() !== "POST" ||
		!/^[a-z0-9]{1,8}$/.test(ext) ||
		!request.body.length ||
		request.body.length > UPLOAD_MAX
	)
		return { status: 400, headers: {}, body: empty };
	mkdirSync(hostPaths.attachments, { recursive: true, mode: 0o700 });
	const path = join(
		hostPaths.attachments,
		`${Date.now()}-${randomBytes(3).toString("hex")}.${ext}`,
	);
	writeFileSync(path, request.body, { mode: 0o600 });
	return {
		status: 200,
		headers: { "content-type": "application/json" },
		body: new TextEncoder().encode(JSON.stringify({ path })),
	};
}

/** One request out of the channel: the host's router (/trpc/), or an upload. */
export const handleRequest: Handler = async (
	request: ChannelRequest,
): Promise<ChannelResponse> => {
	if (request.path.startsWith("/upload?")) return upload(request);
	if (!request.path.startsWith("/trpc/"))
		return { status: 404, headers: {}, body: empty };
	const method = request.method.toUpperCase();
	const response = await fetchRequestHandler({
		endpoint: "/trpc",
		router: hostPhoneRouter,
		req: new Request(`http://odin${request.path}`, {
			method,
			headers: request.headers["content-type"]
				? { "content-type": request.headers["content-type"] }
				: {},
			body:
				method === "GET" || method === "HEAD"
					? undefined
					: request.body.slice(),
		}),
	});
	return {
		status: response.status,
		headers: { "content-type": response.headers.get("content-type") ?? "" },
		body: new Uint8Array(await response.arrayBuffer()),
	};
};

/** Another live server for this user (its pid), or null. */
function runningServer(pidFile: string): number | null {
	try {
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		if (!pid || pid === process.pid) return null;
		process.kill(pid, 0);
		return pid;
	} catch {
		return null;
	}
}

let serving = false;

/**
 * Serves the phone until stopped: one per host user, so a second start
 * leaves the first running and returns null.
 */
export function startHostServer(
	config = readHostConfig(),
): { stop: () => void } | null {
	const files = hostFiles();
	if (!config.relay) throw new Error("No relay set for the phone server");
	if (serving || runningServer(files.pid)) return null;
	serving = true;
	writeFileSync(files.pid, String(process.pid), { mode: 0o600 });
	const trust = createTrust(files);
	const stop = () => {
		serving = false;
		stopRelay();
		if (runningServer(files.pid) === null)
			try {
				unlinkSync(files.pid);
			} catch {}
	};
	const stopRelay = dialRelay(
		config.relay,
		relayId(trust.identity().publicKey),
		(pipe) => serveChannel(pipe, trust, handleRequest),
		undefined,
		undefined,
		// A newer server for this user took the relay: it serves the phones now.
		() => {
			console.log("[phone-host] replaced by a newer server, exiting");
			stop();
			process.exit(0);
		},
	);
	return { stop };
}

/**
 * Every phone unpaired from this host: a new key, an empty list. The running
 * server stops; Odin on the laptop starts it again with the new key.
 */
export async function unpairHost(): Promise<void> {
	const files = hostFiles();
	await createTrust(files).resetTrust();
	const pid = runningServer(files.pid);
	if (pid) process.kill(pid, "SIGTERM");
}
