import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { appState } from "main/lib/app-state";
import type { BoardSnapshot, SnapshotCard } from "main/lib/phone/host/sessions";
import { saveHostLink } from "main/lib/phone/host-link";
import { phoneEnabled, phoneRelay } from "main/lib/phone/server";
import { devices } from "main/lib/phone/trust";
import { loadSessions } from "main/lib/tray";
import type { Client } from "ssh2";
import { readOdinConfig } from "../../../lib/trpc/routers/odin-config";
import { hostOwners } from "./owner";
import {
	phoneHostInfoScript,
	phoneHostScript,
	phoneHostUnpairScript,
} from "./phone-host";
import { connectHost, type HostLogin, runOnHost } from "./ssh";

/**
 * Keeps the phone server on the remote host (phone-host.ts) installed,
 * running and told the board and this computer's paired phones, from this
 * computer's Odin. Its code-less link comes back here (host-link.ts), for
 * the phones to reach it with no second QR code.
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
 * Installs or updates the server, sends the board and the paired phones,
 * starts it, and keeps its link for the phones. Throws when phone access is
 * off: there are no phones to send.
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
			phones: devices(),
			owners: hostOwners(),
		}),
		bundle(),
	);
	const link = (await runOnHost(client, phoneHostInfoScript)).trim();
	if (!link.startsWith("odin://pair?"))
		throw new Error("The remote host gave no link for the phone.");
	saveHostLink(host.instanceId, link);
}

/** At each token push: the server kept current while phone access is on. */
export async function syncPhoneHost(host: Host, client: Client): Promise<void> {
	if (!phoneEnabled()) return;
	await sendPhoneHost(host, client).catch((error) =>
		console.warn("[phone-host] sync:", error),
	);
}

let soon: ReturnType<typeof setTimeout> | null = null;

/**
 * A phone paired with or removed from this computer: the host hears it now,
 * not at the next token push. A few changes in a row make one trip.
 */
export function syncPhoneHostSoon(): void {
	if (soon) clearTimeout(soon);
	soon = setTimeout(() => {
		soon = null;
		const host = readOdinConfig().remoteHost;
		if (!host || !phoneEnabled()) return;
		void (async () => {
			const client = await connectHost(host);
			try {
				await sendPhoneHost(host, client);
			} finally {
				client.end();
			}
		})().catch((error) => console.warn("[phone-host] sync:", error));
	}, 2_000);
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
