import log from "electron-log/main";
import { NOTIFICATION_EVENTS } from "shared/constants";
import type { AgentLifecycleEvent } from "shared/notification-types";
import { notificationsEmitter } from "../notifications/server";
import { getRemoteTerminalRuntime } from "../workspace-runtime/registry";
import { toDesktopEventType } from "./agent-event-types";
import { getRemoteHostEndpoint } from "./host-client";
import { getRemoteConnectionManager } from "./remote-connection-manager";

/**
 * Remote sessions' agent hooks fire on the server: notify.sh posts them to
 * host-service, which records the last state per session and broadcasts it on
 * its `/events` socket. This bridge feeds them into the same AGENT_LIFECYCLE
 * path local hooks take, so cards, banners and sounds behave the same.
 *
 * On every (re)connect it replays each live session's last recorded state -
 * the laptop may have been shut while sessions finished or started waiting
 * on you - skipping states it already delivered.
 */

const EVENTS_RETRY_MS = 3_000;

let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** Last event delivered per pane, so a replay never re-chimes a known state. */
const delivered = new Map<string, AgentLifecycleEvent["eventType"]>();

function deliver(paneId: string, hostEventType: string): void {
	const eventType = toDesktopEventType(hostEventType);
	if (!eventType) return;
	delivered.set(paneId, eventType);
	const record = getRemoteTerminalRuntime().getPaneRecord(paneId);
	const event: AgentLifecycleEvent = {
		paneId,
		terminalId: paneId,
		tabId: record?.tabId,
		workspaceId: record?.workspaceId,
		eventType,
	};
	notificationsEmitter.emit(NOTIFICATION_EVENTS.AGENT_LIFECYCLE, event);
}

async function catchUp(): Promise<void> {
	const endpoint = getRemoteHostEndpoint();
	if (!endpoint) return;
	const { sessions } = await endpoint.client.remoteSessions.list.query();
	for (const session of sessions) {
		if (!session.lastEventType) continue;
		const eventType = toDesktopEventType(session.lastEventType);
		if (!eventType || delivered.get(session.paneId) === eventType) continue;
		deliver(session.paneId, session.lastEventType);
	}
}

function closeSocket(): void {
	if (retryTimer) clearTimeout(retryTimer);
	retryTimer = null;
	const current = socket;
	socket = null;
	try {
		current?.close();
	} catch {
		// Best-effort.
	}
}

function openSocket(): void {
	const endpoint = getRemoteHostEndpoint();
	if (!endpoint || socket) return;
	const url = new URL(`${endpoint.wsBaseUrl}/events`);
	url.searchParams.set("token", endpoint.secret);
	const ws = new WebSocket(url);
	socket = ws;
	ws.addEventListener("open", () => {
		catchUp().catch((error) =>
			log.warn(`[remote-events] catch-up failed: ${error}`),
		);
	});
	ws.addEventListener("message", (event) => {
		if (typeof event.data !== "string") return;
		let message: { type?: string; terminalId?: string; eventType?: string };
		try {
			message = JSON.parse(event.data);
		} catch {
			return;
		}
		if (
			message.type === "agent:lifecycle" &&
			message.terminalId &&
			message.eventType
		) {
			deliver(message.terminalId, message.eventType);
		}
	});
	ws.addEventListener("close", () => {
		if (socket !== ws) return;
		socket = null;
		// Dropped while still connected (host restart): reopen. A tunnel drop
		// is handled by the status listener once the manager reconnects.
		retryTimer = setTimeout(() => {
			retryTimer = null;
			openSocket();
		}, EVENTS_RETRY_MS);
	});
}

let started = false;

/** Start following remote agent events. Idempotent; call once at startup. */
export function startRemoteAgentEventsBridge(): void {
	if (started) return;
	started = true;
	getRemoteConnectionManager().onStatusChange((event) => {
		if (event.status === "connected") {
			closeSocket();
			openSocket();
		} else {
			closeSocket();
		}
	});
	if (getRemoteHostEndpoint()) openSocket();
}
