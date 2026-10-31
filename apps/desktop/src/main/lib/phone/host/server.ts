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
	if (!config.relay) throw new Error("No relay set for the phone server");
	const params = new URLSearchParams({
		k: trust.hostKey(),
		c: trust.pairingCode(),
		r: config.relay,
		h: config.name || "Remote host",
	});
	return `odin://pair?${params}`;
}

const empty = new Uint8Array(0);

/** One request out of the channel, to the host's router. Only /trpc/. */
export const handleRequest: Handler = async (
	request: ChannelRequest,
): Promise<ChannelResponse> => {
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
	const stopRelay = dialRelay(
		config.relay,
		relayId(trust.identity().publicKey),
		(pipe) => serveChannel(pipe, trust, handleRequest),
	);
	return {
		stop: () => {
			serving = false;
			stopRelay();
			if (runningServer(files.pid) === null)
				try {
					unlinkSync(files.pid);
				} catch {}
		},
	};
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
