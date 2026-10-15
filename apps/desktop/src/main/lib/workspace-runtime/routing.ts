/**
 * Routing Workspace Runtime
 *
 * The default runtime. While a remote server is chosen (connected, or
 * reconnecting after a drop) new sessions start on the server; otherwise on
 * the laptop. A pane that already runs somewhere stays there: sessions started
 * locally before connecting keep running locally, and remote ones are never
 * re-homed to the laptop because the tunnel blinked.
 *
 * Listeners register on both backends, so `data:` / `exit:` / `terminalExit`
 * reach the router and the board whichever side a pane runs on.
 */

import { EventEmitter } from "node:events";
import { getRemoteConnectionManager } from "../remote-connection/remote-connection-manager";
import { RemoteTerminalRuntime } from "./remote";
import type {
	TerminalCapabilities,
	TerminalManagement,
	TerminalRuntime,
	WorkspaceRuntime,
	WorkspaceRuntimeId,
} from "./types";

type Listener = (...args: unknown[]) => void;

export function isRemoteSessionMode(): boolean {
	return getRemoteConnectionManager().isRemoteMode();
}

export class RoutingTerminalRuntime
	extends EventEmitter
	implements TerminalRuntime
{
	readonly capabilities: TerminalCapabilities;
	readonly management: TerminalManagement;

	constructor(
		private readonly local: TerminalRuntime,
		readonly remote: RemoteTerminalRuntime,
		private readonly remoteMode: () => boolean = isRemoteSessionMode,
	) {
		super();
		this.capabilities = local.capabilities;
		this.management = {
			listSessions: async () => {
				const localList = await local.management.listSessions();
				if (!this.remoteMode()) return localList;
				const remoteList = await remote.management.listSessions();
				const remoteIds = new Set(remoteList.sessions.map((s) => s.paneId));
				return {
					sessions: [
						...remoteList.sessions,
						...localList.sessions.filter((s) => !remoteIds.has(s.paneId)),
					],
				};
			},
			killAllSessions: async () => {
				await local.management.killAllSessions();
				if (this.remoteMode()) await remote.management.killAllSessions();
			},
			resetHistoryPersistence: () => local.management.resetHistoryPersistence(),
		};
	}

	/**
	 * Which backend owns a pane: a pane alive on the laptop stays there;
	 * everything else follows the mode.
	 */
	private backendFor(paneId: string): TerminalRuntime {
		if (this.local.getSession(paneId)?.isAlive) return this.local;
		return this.remoteMode() ? this.remote : this.local;
	}

	// ── Session operations ───────────────────────────────────────────

	createOrAttach: TerminalRuntime["createOrAttach"] = (params) =>
		this.backendFor(params.paneId).createOrAttach(params);

	cancelCreateOrAttach: TerminalRuntime["cancelCreateOrAttach"] = (params) =>
		this.backendFor(params.paneId).cancelCreateOrAttach(params);

	write: TerminalRuntime["write"] = (params) =>
		this.backendFor(params.paneId).write(params);

	holdKey: TerminalRuntime["holdKey"] = (params) =>
		this.backendFor(params.paneId).holdKey(params);

	releaseKey: TerminalRuntime["releaseKey"] = (params) =>
		this.backendFor(params.paneId).releaseKey(params);

	resize: TerminalRuntime["resize"] = (params) =>
		this.backendFor(params.paneId).resize(params);

	signal: TerminalRuntime["signal"] = (params) =>
		this.backendFor(params.paneId).signal(params);

	kill: TerminalRuntime["kill"] = (params) =>
		this.backendFor(params.paneId).kill(params);

	detach: TerminalRuntime["detach"] = (params) =>
		this.backendFor(params.paneId).detach(params);

	clearScrollback: TerminalRuntime["clearScrollback"] = (params) =>
		this.backendFor(params.paneId).clearScrollback(params);

	readScreen: TerminalRuntime["readScreen"] = (params) =>
		this.backendFor(params.paneId).readScreen(params);

	ackColdRestore: TerminalRuntime["ackColdRestore"] = (paneId) =>
		this.backendFor(paneId).ackColdRestore(paneId);

	getSession: TerminalRuntime["getSession"] = (paneId) =>
		this.backendFor(paneId).getSession(paneId);

	// ── Workspace operations ─────────────────────────────────────────

	killByWorkspaceId: TerminalRuntime["killByWorkspaceId"] = async (
		workspaceId,
	) => {
		const local = await this.local.killByWorkspaceId(workspaceId);
		if (!this.remoteMode()) return local;
		const remote = await this.remote.killByWorkspaceId(workspaceId);
		return {
			killed: local.killed + remote.killed,
			failed: local.failed + remote.failed,
		};
	};

	getSessionCountByWorkspaceId: TerminalRuntime["getSessionCountByWorkspaceId"] =
		async (workspaceId) => {
			const local = await this.local.getSessionCountByWorkspaceId(workspaceId);
			if (!this.remoteMode()) return local;
			return (
				local + (await this.remote.getSessionCountByWorkspaceId(workspaceId))
			);
		};

	refreshPromptsForWorkspace: TerminalRuntime["refreshPromptsForWorkspace"] = (
		workspaceId,
	) => this.local.refreshPromptsForWorkspace(workspaceId);

	// ── Events: listen on both backends ──────────────────────────────

	on(event: string | symbol, listener: Listener): this {
		this.local.on(event, listener);
		this.remote.on(event, listener);
		return this;
	}

	addListener(event: string | symbol, listener: Listener): this {
		return this.on(event, listener);
	}

	once(event: string | symbol, listener: Listener): this {
		const wrapped: Listener = (...args) => {
			this.off(event, wrapped);
			listener(...args);
		};
		return this.on(event, wrapped);
	}

	off(event: string | symbol, listener: Listener): this {
		this.local.off(event, listener);
		this.remote.off(event, listener);
		return this;
	}

	removeListener(event: string | symbol, listener: Listener): this {
		return this.off(event, listener);
	}

	removeAllListeners(event?: string | symbol): this {
		this.local.removeAllListeners(event);
		this.remote.removeAllListeners(event);
		return this;
	}

	/** Synthetic events (the router's own exit/error) reach every listener. */
	emit(event: string | symbol, ...args: unknown[]): boolean {
		return this.local.emit(event, ...args);
	}

	listenerCount(event: string | symbol): number {
		return this.local.listenerCount(event);
	}

	detachAllListeners(): void {
		this.local.detachAllListeners();
		this.remote.detachAllListeners();
	}

	cleanup: TerminalRuntime["cleanup"] = async () => {
		await Promise.all([this.local.cleanup(), this.remote.cleanup()]);
	};
}

export class RoutingWorkspaceRuntime implements WorkspaceRuntime {
	readonly id: WorkspaceRuntimeId = "routing";
	readonly terminal: RoutingTerminalRuntime;
	readonly capabilities: WorkspaceRuntime["capabilities"];

	constructor(local: WorkspaceRuntime) {
		this.terminal = new RoutingTerminalRuntime(
			local.terminal,
			new RemoteTerminalRuntime(),
		);
		this.capabilities = { terminal: this.terminal.capabilities };
	}
}
