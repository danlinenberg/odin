/**
 * A stand-in for Odin's phone server (apps/desktop/src/main/lib/phone), with
 * sample sessions - so the phone screens can be worked on in the Simulator
 * without a Mac-side Odin. Two ways in:
 *
 *   bun run fake-odin            prints an odin://pair link: the real
 *                                encrypted channel, as the app talks to Odin
 *   bun run sim --live           plain HTTP through the dev server (token "fake")
 *
 * Replies land in the chat (with their files' paths); uploads are counted,
 * not kept; the rest of the mutations just answer.
 */
import { acceptChannel, generateKeyPair, type Pipe } from "@odin/channel";
import { demoAnswer } from "../../desktop/src/renderer/mobile/demo";

const PORT = 4799;

async function api(req: Request, from: string): Promise<Response> {
	if (req.headers.get("authorization") !== "Bearer fake")
		return new Response(null, { status: 401 });
	const url = new URL(req.url);
	return demoAnswer(
		url.pathname,
		url.search,
		req.method === "GET" ? "" : await req.text(),
		(path, input) => console.log(from, path, input),
	);
}

/** The channel's side of a Bun socket: whatever acceptChannel hooks up. */
type Hooks = { message?: (data: Uint8Array) => void; close?: () => void };
// A fresh key each run: pair again after a restart. Any phone is welcome.
const me = generateKeyPair();

Bun.serve<Hooks>({
	port: PORT,
	fetch(req, server) {
		// Who's asking: the Simulator (127.0.0.1) or a phone on the Wi-Fi.
		const from = server.requestIP(req)?.address ?? "?";
		if (
			new URL(req.url).pathname === "/channel" &&
			server.upgrade(req, { data: {} })
		)
			return;
		return api(req, from);
	},
	websocket: {
		open(ws) {
			const pipe: Pipe = {
				send: (data) => ws.send(data),
				close: () => ws.close(),
				onMessage: (handler) => {
					ws.data.message = handler;
				},
				onClose: (handler) => {
					ws.data.close = handler;
				},
			};
			acceptChannel(pipe, {
				me,
				accept: () => true,
				handle: async (request) => {
					const answer = await api(
						new Request(`http://fake${request.path}`, {
							method: request.method,
							headers: { ...request.headers, authorization: "Bearer fake" },
							body: request.method === "GET" ? undefined : request.body.slice(),
						}),
						"channel",
					);
					return {
						status: answer.status,
						headers: {
							"content-type": answer.headers.get("content-type") ?? "",
						},
						body: new Uint8Array(await answer.arrayBuffer()),
					};
				},
			});
		},
		message(ws, message) {
			if (typeof message !== "string")
				ws.data.message?.(new Uint8Array(message));
		},
		close(ws) {
			ws.data.close?.();
		},
	},
});
const pair = new URLSearchParams({
	k: Buffer.from(me.publicKey).toString("base64url"),
	l: `ws://localhost:${PORT}/channel`,
});
console.log(`fake Odin on http://localhost:${PORT} (token: fake)`);
console.log(`pair: xcrun simctl openurl booted "odin://pair?${pair}"`);
