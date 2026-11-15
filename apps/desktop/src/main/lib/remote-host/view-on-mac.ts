import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { join } from "node:path";
import { BrowserWindow } from "electron";
import { env } from "shared/env.shared";
import { WebSocket, WebSocketServer } from "ws";
import type { HostLogin } from "./ssh";
import { vscodeHost } from "./vscode-bridge";

/**
 * A `!view <port> <password>` block: a VNC server a remote session started on
 * its host, on the host's localhost only, shown in the session drawer's View
 * tab by noVNC (HostScreenView). noVNC takes tight encoding with JPEG, far less
 * over the link than macOS Screen Sharing's lossless zlib. noVNC talks to a
 * WebSocket bridge here (wsBridge), never to the host's server directly. The tunnel is ssh
 * through the same bridge VS Code on the host uses, so it needs no open port;
 * it stays up for the next click and goes when the ssh dies.
 */

/** A port nothing on this computer listens on. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as net.AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

const answers = (port: number) =>
	new Promise<boolean>((resolve) => {
		const socket = net.connect(port, "127.0.0.1");
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});

/** Tunnels by host port, so a second click on the same block reuses its tunnel. */
const tunnels = new Map<number, { local: number; ssh: ChildProcess }>();

async function openTunnel(alias: string, port: number): Promise<number> {
	const open = tunnels.get(port);
	if (open && open.ssh.exitCode === null && (await answers(open.local)))
		return open.local;
	const local = await freePort();
	const ssh = spawn(
		"ssh",
		[
			"-N",
			"-o",
			"ExitOnForwardFailure=yes",
			"-o",
			"ServerAliveInterval=30",
			"-L",
			`${local}:127.0.0.1:${port}`,
			alias,
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let said = "";
	ssh.stderr?.on("data", (chunk) => {
		said += chunk;
	});
	tunnels.set(port, { local, ssh });
	ssh.once("exit", () => {
		if (tunnels.get(port)?.ssh === ssh) tunnels.delete(port);
	});
	// The bridge pushes a one-time key over SSM first: the tunnel takes ~10s.
	for (const end = Date.now() + 60_000; Date.now() < end; ) {
		if (ssh.exitCode !== null) break;
		if (await answers(local)) return local;
		await new Promise((r) => setTimeout(r, 1000));
	}
	ssh.kill();
	throw new Error(
		`The tunnel to the host did not come up${said.trim() ? `: ${said.trim().split("\n").at(-1)}` : "."}`,
	);
}

/** WebSocket bridges by tunnel port: noVNC speaks WebSocket, the host's VNC server raw RFB. */
const bridges = new Map<number, { port: number; server: WebSocketServer }>();

/**
 * A WebSocket server on this computer that pipes each noVNC connection to the
 * tunnel as raw RFB. The host's x11vnc only takes a WebSocket when its first
 * bytes land within ~100ms of the connect, which the SSM tunnel often misses:
 * then it drops the client as "not a valid RFB client: GET / HTTP/1".
 */
async function wsBridge(tunnel: number): Promise<number> {
	const open = bridges.get(tunnel);
	if (open) return open.port;
	const port = await freePort();
	const server = new WebSocketServer({ host: "127.0.0.1", port });
	server.on("connection", (ws) => {
		const tcp = net.connect(tunnel, "127.0.0.1");
		tcp.setNoDelay(true);
		tcp.on("data", (data) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(data);
		});
		ws.on("message", (data) => tcp.write(data as Buffer));
		const end = () => {
			tcp.destroy();
			ws.close();
		};
		tcp.on("close", end);
		tcp.on("error", end);
		ws.on("close", end);
		ws.on("error", end);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	bridges.set(tunnel, { port, server });
	return port;
}

/**
 * Opens (or reuses) the tunnel to the host's screen on `port` and returns the
 * local WebSocket port in front of it, which the drawer's View tab hands noVNC.
 */
export async function viewOnMac(
	host: HostLogin & { name?: string | null },
	port: number,
): Promise<number> {
	const tunnel = await openTunnel(await vscodeHost(host), port);
	for (const [old, bridge] of bridges)
		if (old !== tunnel && ![...tunnels.values()].some((t) => t.local === old)) {
			bridge.server.close();
			bridges.delete(old);
		}
	return wsBridge(tunnel);
}

/** The viewer page, from the dev server or the built renderer, like the main window. */
function loadViewer(window: BrowserWindow, query: Record<string, string>) {
	if (env.NODE_ENV === "development")
		return window.loadURL(
			`http://localhost:${env.DESKTOP_VITE_PORT}/vnc-viewer.html?${new URLSearchParams(query)}`,
		);
	return window.loadFile(join(__dirname, "../renderer/vnc-viewer.html"), {
		query,
	});
}

/** One window per host port: a second click brings it to the front. */
const windows = new Map<number, BrowserWindow>();

/**
 * The View tab's Open in window: the host's screen on `port` in its own
 * resizable Odin window, over the same tunnel the drawer uses.
 */
export async function viewInWindow(
	host: HostLogin & { name?: string | null },
	port: number,
	password: string,
): Promise<void> {
	const shown = windows.get(port);
	if (shown && !shown.isDestroyed()) {
		shown.show();
		shown.focus();
		return;
	}
	const local = await viewOnMac(host, port);
	const window = new BrowserWindow({
		width: 1200,
		height: 790,
		title: "View",
		backgroundColor: "#111111",
		webPreferences: { sandbox: true, contextIsolation: true },
	});
	windows.set(port, window);
	window.on("closed", () => windows.delete(port));
	await loadViewer(window, { port: String(local), password });
}
