/**
 * Remote Workspace Runtime
 *
 * Runs terminal sessions on the connected server's host-service instead of
 * the laptop's terminal-host daemon. The renderer's terminal API is unchanged:
 * the host terminal id is the pane id, output arrives over the host's
 * `/terminal/<id>` WebSocket and is re-emitted as the same `data:` / `exit:`
 * events the local runtime emits.
 *
 * The session lives in the server's pty-daemon, so closing the laptop only
 * drops the WebSocket. On the next attach the pane reconnects and repaints.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import path from "node:path";
import log from "electron-log/main";
import { ODIN_HOME_DIR } from "../app-environment";
import {
	getRemoteHostEndpoint,
	type RemoteHostEndpoint,
	requireRemoteHostEndpoint,
} from "../remote-connection/host-client";
import type { CreateSessionParams, SessionResult } from "../terminal/types";
import type { ListSessionsResponse } from "../terminal-host/types";
import type {
	TerminalCapabilities,
	TerminalManagement,
	TerminalRuntime,
} from "./types";

/** The desktop side of a remote pane, persisted so it survives app restarts. */
interface RemotePaneRecord {
	tabId: string;
	/** The desktop workspace (local-db) the pane belongs to. */
	workspaceId: string;
	cwd: string | null;
}

interface PaneConnection {
	paneId: string;
	hostWorkspaceId: string;
	socket: WebSocket | null;
	/** Input written before the socket opened. */
	pending: string[];
	decoder: TextDecoder;
	cols: number;
	rows: number;
	exited: boolean;
	closedByUs: boolean;
	lastActive: number;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
}

const PANES_FILE = path.join(ODIN_HOME_DIR, "remote-panes.json");
const LIST_CACHE_MS = 1_000;
const SOCKET_RECONNECT_MS = 2_000;

function readPaneRecords(): Record<string, RemotePaneRecord> {
	try {
		return JSON.parse(fs.readFileSync(PANES_FILE, "utf8"));
	} catch {
		return {};
	}
}

/** A path the server can use: POSIX-absolute. Laptop paths never are on Windows. */
export function serverPath(candidate: string | undefined): string | undefined {
	return candidate?.startsWith("/") ? candidate : undefined;
}

export class RemoteTerminalRuntime
	extends EventEmitter
	implements TerminalRuntime
{
	readonly capabilities: TerminalCapabilities = {
		persistent: true,
		coldRestore: false,
	};
	readonly management: TerminalManagement;

	private readonly connections = new Map<string, PaneConnection>();
	private readonly pendingAttach = new Map<string, Promise<SessionResult>>();
	private readonly heldKeys = new Map<string, ReturnType<typeof setInterval>>();
	private paneRecords: Record<string, RemotePaneRecord> = readPaneRecords();
	private listCache: { at: number; value: ListSessionsResponse } | null = null;

	constructor() {
		super();
		this.setMaxListeners(0);
		this.management = {
			listSessions: () => this.listSessions(),
			killAllSessions: async () => {
				const { sessions } = await this.listSessions();
				await Promise.all(
					sessions.map((session) => this.kill({ paneId: session.paneId })),
				);
			},
			resetHistoryPersistence: async () => {},
		};
	}

	// ── Session operations ───────────────────────────────────────────

	createOrAttach(params: CreateSessionParams): Promise<SessionResult> {
		const inFlight = this.pendingAttach.get(params.paneId);
		if (inFlight && params.joinPending) return inFlight;
		const attempt = this.doCreateOrAttach(params).finally(() => {
			if (this.pendingAttach.get(params.paneId) === attempt) {
				this.pendingAttach.delete(params.paneId);
			}
		});
		this.pendingAttach.set(params.paneId, attempt);
		return attempt;
	}

	private async doCreateOrAttach(
		params: CreateSessionParams,
	): Promise<SessionResult> {
		const endpoint = requireRemoteHostEndpoint();
		const cwd = serverPath(params.cwd) ?? serverPath(params.workspacePath);
		const cols = params.cols ?? 120;
		const rows = params.rows ?? 32;
		// A command always starts fresh: the caller killed the old run first
		// (resume, Start over), so never adopt a stale socket for it.
		if (params.command) this.dropConnection(params.paneId);

		const opened = await endpoint.client.remoteSessions.open.mutate({
			paneId: params.paneId,
			tabId: params.tabId,
			cwd,
			command: params.command,
			cols,
			rows,
			themeType: params.themeType,
		});
		this.rememberPane(params.paneId, {
			tabId: params.tabId,
			workspaceId: params.workspaceId,
			cwd: cwd ?? null,
		});
		this.listCache = null;

		const isNew = opened.status === "created";
		const connection = this.ensureConnection(
			endpoint,
			params.paneId,
			opened.workspaceId,
			cols,
			rows,
		);
		connection.exited = false;

		// A fresh pane paints from the stream. An attach to a running session
		// gets the server's current screen now, then a repaint (resize below).
		const screen = isNew
			? ""
			: ((await this.snapshotText(endpoint, params.paneId)) ?? "");
		if (!isNew) this.nudgeRepaint(connection);

		return {
			isNew,
			scrollback: "",
			wasRecovered: !isNew,
			snapshot: {
				snapshotAnsi: screen,
				rehydrateSequences: "",
				cwd: cwd ?? null,
				modes: {},
				cols,
				rows,
				scrollbackLines: 0,
			},
		};
	}

	cancelCreateOrAttach(_params: { paneId: string; requestId: string }): void {
		// The server call is short; a superseded attach simply resolves unused.
	}

	write({ paneId, data }: { paneId: string; data: string }): void {
		const connection = this.connections.get(paneId);
		if (!connection) {
			log.warn(`[remote-runtime] write to unattached pane ${paneId}`);
			return;
		}
		connection.lastActive = Date.now();
		if (connection.socket?.readyState === WebSocket.OPEN) {
			connection.socket.send(JSON.stringify({ type: "input", data }));
		} else {
			connection.pending.push(data);
		}
	}

	/**
	 * Hold a key: repeat `data` every `everyMs` until releaseKey. Timed here in
	 * main, the closest Odin gets to a server PTY - the renderer's timers stall
	 * when its window is busy.
	 */
	async holdKey({
		paneId,
		data,
		everyMs,
	}: {
		paneId: string;
		data: string;
		everyMs: number;
	}): Promise<void> {
		await this.releaseKey({ paneId });
		this.write({ paneId, data });
		this.heldKeys.set(
			paneId,
			setInterval(() => this.write({ paneId, data }), Math.max(10, everyMs)),
		);
	}

	async releaseKey({ paneId }: { paneId: string }): Promise<void> {
		const timer = this.heldKeys.get(paneId);
		if (timer) clearInterval(timer);
		this.heldKeys.delete(paneId);
	}

	resize({
		paneId,
		cols,
		rows,
	}: {
		paneId: string;
		cols: number;
		rows: number;
	}): void {
		const connection = this.connections.get(paneId);
		if (!connection) return;
		connection.cols = cols;
		connection.rows = rows;
		this.sendResize(connection, cols, rows);
	}

	signal({ paneId, signal }: { paneId: string; signal?: string }): void {
		// The host terminal takes input, not signals: an interrupt is ^C.
		if (!signal || signal === "SIGINT") {
			this.write({ paneId, data: "\x03" });
			return;
		}
		void this.kill({ paneId });
	}

	async kill({ paneId }: { paneId: string }): Promise<void> {
		const connection = this.connections.get(paneId);
		const endpoint = getRemoteHostEndpoint();
		if (endpoint) {
			await endpoint.client.remoteSessions.kill
				.mutate({ paneId })
				.catch((error) =>
					log.warn(`[remote-runtime] kill ${paneId} failed: ${error}`),
				);
		}
		this.listCache = null;
		if (connection && !connection.exited) {
			connection.exited = true;
			this.emitExit(paneId, 0, 15, "killed");
		}
		this.dropConnection(paneId);
	}

	detach({ paneId }: { paneId: string }): void {
		// The session keeps running on the server; only the stream closes.
		this.dropConnection(paneId);
	}

	clearScrollback(_params: { paneId: string }): void {}

	async readScreen({ paneId }: { paneId: string }): Promise<string | null> {
		const endpoint = getRemoteHostEndpoint();
		return endpoint ? this.snapshotText(endpoint, paneId) : null;
	}

	ackColdRestore(_paneId: string): void {}

	getSession(
		paneId: string,
	): { isAlive: boolean; cwd: string; lastActive: number } | null {
		const connection = this.connections.get(paneId);
		const record = this.paneRecords[paneId];
		if (!connection && !record) return null;
		return {
			isAlive: !!connection && !connection.exited,
			cwd: record?.cwd ?? "",
			lastActive: connection?.lastActive ?? 0,
		};
	}

	// ── Workspace operations ─────────────────────────────────────────

	async killByWorkspaceId(
		workspaceId: string,
	): Promise<{ killed: number; failed: number }> {
		const { sessions } = await this.listSessions();
		let killed = 0;
		let failed = 0;
		for (const session of sessions) {
			if (session.workspaceId !== workspaceId) continue;
			try {
				await this.kill({ paneId: session.paneId });
				killed++;
			} catch {
				failed++;
			}
		}
		return { killed, failed };
	}

	async getSessionCountByWorkspaceId(workspaceId: string): Promise<number> {
		const { sessions } = await this.listSessions();
		return sessions.filter((session) => session.workspaceId === workspaceId)
			.length;
	}

	refreshPromptsForWorkspace(_workspaceId: string): void {}

	// ── Management ───────────────────────────────────────────────────

	/**
	 * Live sessions on the server. Throws while the tunnel is down rather than
	 * answering "none": an empty list would read as every session having died,
	 * and the board would close or re-launch them.
	 */
	private async listSessions(): Promise<ListSessionsResponse> {
		const endpoint = requireRemoteHostEndpoint();
		if (this.listCache && Date.now() - this.listCache.at < LIST_CACHE_MS) {
			return this.listCache.value;
		}
		const { sessions } = await endpoint.client.remoteSessions.list.query();
		const value: ListSessionsResponse = {
			sessions: sessions.map((session) => ({
				sessionId: session.paneId,
				paneId: session.paneId,
				workspaceId:
					this.paneRecords[session.paneId]?.workspaceId ?? session.workspaceId,
				isAlive: true,
				attachedClients: this.connections.has(session.paneId) ? 1 : 0,
				pid: session.pid,
				createdAt: new Date(session.createdAt).toISOString(),
				lastAttachedAt: session.lastAttachedAt
					? new Date(session.lastAttachedAt).toISOString()
					: undefined,
			})),
		};
		this.listCache = { at: Date.now(), value };
		return value;
	}

	/** Desktop tab and workspace of a pane run remotely, if known. */
	getPaneRecord(paneId: string): RemotePaneRecord | null {
		return this.paneRecords[paneId] ?? null;
	}

	// ── Streaming ────────────────────────────────────────────────────

	private ensureConnection(
		endpoint: RemoteHostEndpoint,
		paneId: string,
		hostWorkspaceId: string,
		cols: number,
		rows: number,
	): PaneConnection {
		const existing = this.connections.get(paneId);
		if (existing && existing.hostWorkspaceId === hostWorkspaceId) {
			existing.cols = cols;
			existing.rows = rows;
			if (!existing.socket) this.openSocket(endpoint, existing);
			return existing;
		}
		if (existing) this.dropConnection(paneId);
		const connection: PaneConnection = {
			paneId,
			hostWorkspaceId,
			socket: null,
			pending: [],
			decoder: new TextDecoder("utf-8"),
			cols,
			rows,
			exited: false,
			closedByUs: false,
			lastActive: Date.now(),
			reconnectTimer: null,
		};
		this.connections.set(paneId, connection);
		this.openSocket(endpoint, connection);
		return connection;
	}

	private openSocket(
		endpoint: RemoteHostEndpoint,
		connection: PaneConnection,
	): void {
		const url = new URL(
			`${endpoint.wsBaseUrl}/terminal/${encodeURIComponent(connection.paneId)}`,
		);
		url.searchParams.set("workspaceId", connection.hostWorkspaceId);
		url.searchParams.set("token", endpoint.secret);
		const socket = new WebSocket(url);
		socket.binaryType = "arraybuffer";
		connection.socket = socket;
		connection.closedByUs = false;

		socket.addEventListener("open", () => {
			this.sendResize(connection, connection.cols, connection.rows);
			for (const data of connection.pending.splice(0)) {
				socket.send(JSON.stringify({ type: "input", data }));
			}
		});
		socket.addEventListener("message", (event) => {
			if (typeof event.data === "string") {
				this.handleControl(connection, event.data);
				return;
			}
			const text = connection.decoder.decode(
				new Uint8Array(event.data as ArrayBuffer),
				{ stream: true },
			);
			if (!text) return;
			connection.lastActive = Date.now();
			this.emit(`data:${connection.paneId}`, text);
		});
		socket.addEventListener("close", () => {
			if (connection.socket !== socket) return;
			connection.socket = null;
			if (connection.closedByUs || connection.exited) return;
			// The tunnel blinked or the host restarted: the session is still
			// running there, so keep trying while the pane is attached.
			connection.reconnectTimer = setTimeout(() => {
				connection.reconnectTimer = null;
				if (this.connections.get(connection.paneId) !== connection) return;
				const next = getRemoteHostEndpoint();
				if (next) this.openSocket(next, connection);
				else this.scheduleSocketRetry(connection);
			}, SOCKET_RECONNECT_MS);
		});
		socket.addEventListener("error", () => {
			// "close" follows and handles the retry.
		});
	}

	private scheduleSocketRetry(connection: PaneConnection): void {
		connection.reconnectTimer = setTimeout(() => {
			connection.reconnectTimer = null;
			if (this.connections.get(connection.paneId) !== connection) return;
			const endpoint = getRemoteHostEndpoint();
			if (endpoint) this.openSocket(endpoint, connection);
			else this.scheduleSocketRetry(connection);
		}, SOCKET_RECONNECT_MS);
	}

	private handleControl(connection: PaneConnection, raw: string): void {
		let message: {
			type?: string;
			exitCode?: number;
			signal?: number;
			message?: string;
			code?: string;
		};
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}
		if (message.type === "exit") {
			if (connection.exited) return;
			connection.exited = true;
			this.listCache = null;
			this.emitExit(
				connection.paneId,
				message.exitCode ?? 0,
				message.signal || undefined,
				"exited",
			);
			return;
		}
		if (message.type === "error") {
			if (message.code === "session-gone") {
				if (!connection.exited) {
					connection.exited = true;
					this.emitExit(connection.paneId, 0, undefined, "exited");
				}
				this.dropConnection(connection.paneId);
				return;
			}
			this.emit(`error:${connection.paneId}`, {
				error: message.message ?? "Remote terminal error",
				code: message.code,
			});
		}
	}

	private emitExit(
		paneId: string,
		exitCode: number,
		signal: number | undefined,
		reason: "killed" | "exited" | "error",
	): void {
		this.emit(`exit:${paneId}`, exitCode, signal, reason);
		this.emit("terminalExit", { paneId, exitCode, signal, reason });
	}

	private sendResize(
		connection: PaneConnection,
		cols: number,
		rows: number,
	): void {
		if (connection.socket?.readyState !== WebSocket.OPEN) return;
		connection.socket.send(JSON.stringify({ type: "resize", cols, rows }));
	}

	/**
	 * Make a full-screen TUI redraw for a pane that attached mid-session: a size
	 * change sends SIGWINCH, and Claude Code repaints the whole screen.
	 */
	private nudgeRepaint(connection: PaneConnection): void {
		const { cols, rows } = connection;
		const send = () => {
			this.sendResize(connection, Math.max(20, cols - 1), rows);
			setTimeout(() => this.sendResize(connection, cols, rows), 120);
		};
		if (connection.socket?.readyState === WebSocket.OPEN) send();
		else connection.socket?.addEventListener("open", send, { once: true });
	}

	private async snapshotText(
		endpoint: RemoteHostEndpoint,
		paneId: string,
	): Promise<string | null> {
		const snapshot = await endpoint.client.remoteSessions.snapshot
			.query({ paneId })
			.catch(() => null);
		return snapshot ? snapshot.text.replace(/\r?\n/g, "\r\n") : null;
	}

	private dropConnection(paneId: string): void {
		void this.releaseKey({ paneId });
		const connection = this.connections.get(paneId);
		if (!connection) return;
		this.connections.delete(paneId);
		if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
		connection.closedByUs = true;
		try {
			connection.socket?.close();
		} catch {
			// Best-effort.
		}
		connection.socket = null;
	}

	private rememberPane(paneId: string, record: RemotePaneRecord): void {
		const previous = this.paneRecords[paneId];
		if (
			previous?.tabId === record.tabId &&
			previous.workspaceId === record.workspaceId &&
			previous.cwd === record.cwd
		) {
			return;
		}
		this.paneRecords = { ...this.paneRecords, [paneId]: record };
		fs.promises
			.writeFile(PANES_FILE, JSON.stringify(this.paneRecords), {
				mode: 0o600,
			})
			.catch((error) =>
				log.warn(`[remote-runtime] could not save pane records: ${error}`),
			);
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	detachAllListeners(): void {
		for (const event of this.eventNames()) {
			const name = String(event);
			if (
				name.startsWith("data:") ||
				name.startsWith("exit:") ||
				name.startsWith("disconnect:") ||
				name.startsWith("error:")
			) {
				this.removeAllListeners(event);
			}
		}
	}

	async cleanup(): Promise<void> {
		for (const paneId of [...this.connections.keys()]) {
			this.dropConnection(paneId);
		}
	}
}
