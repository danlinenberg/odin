import type { Pipe } from "./channel";

/**
 * A standard WebSocket (browser, the iPhone's web view, Bun, Node 22+) as a
 * channel pipe: one binary message per Noise message.
 */
export function websocketPipe(socket: WebSocket): Pipe {
	socket.binaryType = "arraybuffer";
	return {
		// A copy: its own ArrayBuffer, never a view into a shared one.
		send: (data) => socket.send(data.slice()),
		close: () => socket.close(),
		onMessage: (handler) =>
			socket.addEventListener("message", (event) => {
				// arraybuffer is asked for; a runtime that ignores it sends a view.
				const data = event.data;
				if (data instanceof ArrayBuffer) handler(new Uint8Array(data));
				else if (ArrayBuffer.isView(data))
					handler(
						new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
					);
			}),
		onClose: (handler) => socket.addEventListener("close", () => handler()),
	};
}

/**
 * Opens a WebSocket for binary messages. binaryType is set before it opens:
 * a message can arrive in the same moment (a relay hands over the phone's
 * handshake as soon as the host's socket opens).
 */
export function connectSocket(url: string): Promise<WebSocket> {
	const socket = new WebSocket(url);
	socket.binaryType = "arraybuffer";
	return opened(socket);
}

/** Resolves once the socket is open; rejects if it closes or errors first. */
export function opened(socket: WebSocket): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		if (socket.readyState === WebSocket.OPEN) return resolve(socket);
		socket.addEventListener("open", () => resolve(socket), { once: true });
		socket.addEventListener(
			"error",
			() => reject(new Error("Couldn't connect")),
			{
				once: true,
			},
		);
		socket.addEventListener(
			"close",
			() => reject(new Error("Couldn't connect")),
			{
				once: true,
			},
		);
	});
}
