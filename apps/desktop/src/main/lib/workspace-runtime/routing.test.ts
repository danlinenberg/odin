import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { RemoteTerminalRuntime } from "./remote";
import { RoutingTerminalRuntime } from "./routing";
import type { TerminalRuntime } from "./types";

/** A backend that records calls and knows which panes are alive on it. */
function fakeBackend(
	name: string,
	{
		alive = [] as string[],
		sessions = [] as string[],
		listError = null as Error | null,
	} = {},
) {
	const calls: string[] = [];
	const emitter = new EventEmitter();
	const backend = Object.assign(emitter, {
		calls,
		capabilities: { persistent: true, coldRestore: name === "local" },
		management: {
			listSessions: async () => {
				if (listError) throw listError;
				return {
					sessions: sessions.map((paneId) => ({
						sessionId: paneId,
						paneId,
						workspaceId: "ws",
						isAlive: true,
						attachedClients: 0,
						pid: 1,
					})),
				};
			},
			killAllSessions: async () => {
				calls.push("killAll");
			},
			resetHistoryPersistence: async () => {},
		},
		createOrAttach: async (params: { paneId: string }) => {
			calls.push(`createOrAttach:${params.paneId}`);
			return { isNew: true, scrollback: "", wasRecovered: false };
		},
		cancelCreateOrAttach: () => {},
		write: ({ paneId }: { paneId: string }) => {
			calls.push(`write:${paneId}`);
		},
		resize: () => {},
		signal: () => {},
		kill: async ({ paneId }: { paneId: string }) => {
			calls.push(`kill:${paneId}`);
		},
		detach: () => {},
		clearScrollback: () => {},
		readScreen: async () => null,
		ackColdRestore: () => {},
		getSession: (paneId: string) =>
			alive.includes(paneId)
				? { isAlive: true, cwd: "/", lastActive: 0 }
				: null,
		killByWorkspaceId: async () => ({ killed: 0, failed: 0 }),
		getSessionCountByWorkspaceId: async () => 0,
		refreshPromptsForWorkspace: () => {},
		detachAllListeners: () => {},
		cleanup: async () => {},
	});
	return backend;
}

function routing({
	remoteMode,
	localAlive = [] as string[],
	localSessions = [] as string[],
	remoteSessions = [] as string[],
	remoteListError = null as Error | null,
}: {
	remoteMode: boolean;
	localAlive?: string[];
	localSessions?: string[];
	remoteSessions?: string[];
	remoteListError?: Error | null;
}) {
	const local = fakeBackend("local", {
		alive: localAlive,
		sessions: localSessions,
	});
	const remote = fakeBackend("remote", {
		sessions: remoteSessions,
		listError: remoteListError,
	});
	const runtime = new RoutingTerminalRuntime(
		local as unknown as TerminalRuntime,
		remote as unknown as RemoteTerminalRuntime,
		() => remoteMode,
	);
	return { runtime, local, remote };
}

describe("RoutingTerminalRuntime", () => {
	it("starts new sessions on the laptop when no server is chosen", async () => {
		const { runtime, local, remote } = routing({ remoteMode: false });
		await runtime.createOrAttach({
			paneId: "p1",
			tabId: "t",
			workspaceId: "w",
		});
		expect(local.calls).toEqual(["createOrAttach:p1"]);
		expect(remote.calls).toEqual([]);
	});

	it("starts new sessions on the server in remote mode", async () => {
		const { runtime, local, remote } = routing({ remoteMode: true });
		await runtime.createOrAttach({
			paneId: "p1",
			tabId: "t",
			workspaceId: "w",
		});
		runtime.write({ paneId: "p1", data: "x" });
		expect(remote.calls).toEqual(["createOrAttach:p1", "write:p1"]);
		expect(local.calls).toEqual([]);
	});

	it("keeps a session already running on the laptop there after connecting", async () => {
		const { runtime, local, remote } = routing({
			remoteMode: true,
			localAlive: ["old"],
		});
		runtime.write({ paneId: "old", data: "x" });
		await runtime.kill({ paneId: "old" });
		expect(local.calls).toEqual(["write:old", "kill:old"]);
		expect(remote.calls).toEqual([]);
	});

	it("delivers events from either backend to one listener", () => {
		const { runtime, local, remote } = routing({ remoteMode: true });
		const seen: string[] = [];
		runtime.on("data:p1", (data) => seen.push(String(data)));
		local.emit("data:p1", "from-laptop");
		remote.emit("data:p1", "from-server");
		expect(seen).toEqual(["from-laptop", "from-server"]);
	});

	it("stops delivering after off()", () => {
		const { runtime, remote } = routing({ remoteMode: true });
		const seen: string[] = [];
		const listener = (data: unknown) => seen.push(String(data));
		runtime.on("exit:p1", listener);
		runtime.off("exit:p1", listener);
		remote.emit("exit:p1", 0);
		expect(seen).toEqual([]);
	});

	it("lists server sessions alongside laptop ones in remote mode", async () => {
		const { runtime } = routing({
			remoteMode: true,
			localSessions: ["laptop-pane", "both"],
			remoteSessions: ["server-pane", "both"],
		});
		const { sessions } = await runtime.management.listSessions();
		expect(sessions.map((s) => s.paneId).sort()).toEqual([
			"both",
			"laptop-pane",
			"server-pane",
		]);
	});

	// An empty list would read as every remote session having died - the board
	// would close or re-launch them on the laptop.
	it("fails the list while the server is unreachable instead of answering none", async () => {
		const { runtime } = routing({
			remoteMode: true,
			remoteSessions: ["server-pane"],
			remoteListError: new Error("not connected"),
		});
		await expect(runtime.management.listSessions()).rejects.toThrow(
			"not connected",
		);
	});

	it("lists only laptop sessions outside remote mode", async () => {
		const { runtime } = routing({
			remoteMode: false,
			localSessions: ["laptop-pane"],
			remoteListError: new Error("must not be asked"),
		});
		const { sessions } = await runtime.management.listSessions();
		expect(sessions.map((s) => s.paneId)).toEqual(["laptop-pane"]);
	});
});
