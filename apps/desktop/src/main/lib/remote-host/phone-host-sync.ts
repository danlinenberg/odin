import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { appState } from "main/lib/app-state";
import type { BoardSnapshot, SnapshotCard } from "main/lib/phone/host/sessions";
import { phoneEnabled, phoneRelay } from "main/lib/phone/server";
import { loadSessions } from "main/lib/tray";
import QRCode from "qrcode";
import type { Client } from "ssh2";
import {
	phoneHostLinkScript,
	phoneHostScript,
	phoneHostUnpairScript,
} from "./phone-host";
import { connectHost, type HostLogin, runOnHost } from "./ssh";

/**
 * Keeps the phone server on the remote host (phone-host.ts) installed,
 * running and told the board, from this computer's Odin.
 */

type Host = HostLogin & { name?: string };

const hostName = (host: Host) => host.name || host.instanceId;

/** The server's JavaScript, built beside the main process (electron.vite.config). */
const bundle = () =>
	readFileSync(join(app.getAppPath(), "dist", "main", "phone-host.js"), "utf8");

/** This computer's remote cards, with their Claude sessions: titles and tags for the host's board. */
async function boardSnapshot(host: Host): Promise<BoardSnapshot> {
	const panes = appState.data.tabsState.panes ?? {};
	const sessions: SnapshotCard[] = [];
	for (const row of await loadSessions(true, null)) {
		const sessionId = panes[row.paneId]?.claudeSessionId;
		if (row.remote && sessionId) sessions.push({ ...row, sessionId });
	}
	return { host: hostName(host), sessions };
}

/**
 * Installs or updates the server, sends the board, and starts it. Throws
 * when phone access is off: there is nothing to pair a phone with.
 */
export async function sendPhoneHost(host: Host, client: Client): Promise<void> {
	const relay = phoneRelay();
	if (!phoneEnabled() || !relay) throw new Error("Turn on Phone access first.");
	await runOnHost(
		client,
		phoneHostScript({
			relay,
			name: hostName(host),
			board: await boardSnapshot(host),
		}),
		bundle(),
	);
}

/** At each token push: the server kept current while phone access is on. */
export async function syncPhoneHost(host: Host, client: Client): Promise<void> {
	if (!phoneEnabled()) return;
	await sendPhoneHost(host, client).catch((error) =>
		console.warn("[phone-host] sync:", error),
	);
}

/** Settings' second QR code: the host's pairing link, with the server running. */
export async function phoneHostPairing(
	host: Host,
): Promise<{ link: string; qr: string; name: string }> {
	const client = await connectHost(host);
	try {
		await sendPhoneHost(host, client);
		const link = (await runOnHost(client, phoneHostLinkScript)).trim();
		if (!link.startsWith("odin://pair?"))
			throw new Error("The remote host gave no pairing link.");
		return {
			link,
			qr: await QRCode.toDataURL(link, { margin: 1, width: 220 }),
			name: hostName(host),
		};
	} finally {
		client.end();
	}
}

/** Unpair all reaches the host's phones too. */
export async function unpairPhoneHost(host: Host): Promise<void> {
	const client = await connectHost(host);
	try {
		await runOnHost(client, phoneHostUnpairScript);
		if (phoneEnabled()) await sendPhoneHost(host, client);
	} finally {
		client.end();
	}
}
