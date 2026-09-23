import { expect, test } from "bun:test";

import { coalesceFullReloadPlugin } from "./helpers";

function fakeServer() {
	const sent: unknown[] = [];
	const listeners: Record<string, (data: unknown) => void> = {};
	const server = {
		environments: {
			client: {
				hot: {
					send: (p: unknown) => sent.push(p),
					on: (e: string, fn: (data: unknown) => void) => {
						listeners[e] = fn;
					},
				},
			},
		},
		emit: (e: string, data?: unknown) => listeners[e]?.(data),
		config: { logger: { info: () => {} } },
	};
	return { sent, server };
}

function install(
	plugin: ReturnType<typeof coalesceFullReloadPlugin>,
	server: unknown,
) {
	// biome-ignore lint/suspicious/noExplicitAny: fake server, not a real ViteDevServer
	(plugin.configureServer as any).call(plugin, server);
}

const reload = { type: "full-reload" };
const update = { type: "update", updates: [] };

test("a burst of full reloads becomes one, after the saves go quiet", async () => {
	const { sent, server } = fakeServer();
	install(coalesceFullReloadPlugin({ quietMs: 30, maxHoldMs: 10_000 }), server);
	const hot = server.environments.client.hot;

	hot.send(update);
	hot.send(reload);
	hot.send(reload);
	hot.send(reload);
	expect(sent).toEqual([update]);

	await new Promise((r) => setTimeout(r, 80));
	expect(sent).toEqual([update, reload]);
});

test("a save storm that never goes quiet still reloads once maxHold passes", async () => {
	const { sent, server } = fakeServer();
	install(coalesceFullReloadPlugin({ quietMs: 10_000, maxHoldMs: 30 }), server);
	const hot = server.environments.client.hot;

	hot.send(reload);
	expect(sent).toEqual([]);

	await new Promise((r) => setTimeout(r, 50));
	hot.send(reload);
	expect(sent).toEqual([reload]);
});

test("an open session pane holds everything; closing it lands one reload", async () => {
	const { sent, server } = fakeServer();
	install(coalesceFullReloadPlugin({ quietMs: 10, maxHoldMs: 20 }), server);
	const hot = server.environments.client.hot;

	server.emit("odin:session-pane", true);
	hot.send(update);
	hot.send(reload);
	await new Promise((r) => setTimeout(r, 50));
	hot.send(reload);
	expect(sent).toEqual([]);

	server.emit("odin:session-pane", false);
	expect(sent).toEqual([reload]);
});

test("closing a pane with only hot updates held replays them in order", () => {
	const { sent, server } = fakeServer();
	install(coalesceFullReloadPlugin(), server);
	const hot = server.environments.client.hot;
	const second = { type: "update", updates: [1] };

	server.emit("odin:session-pane", true);
	hot.send(update);
	hot.send(second);
	server.emit("odin:session-pane", false);
	expect(sent).toEqual([update, second]);
});
