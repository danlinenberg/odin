import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Client } from "ssh2";
import { hostHasConversation, withSharedHost } from "./host-conversations";

const host = { instanceId: "i-1", user: "odin-dan" };

/** A client whose every exec prints `answer`; counts how often it was ended. */
function fakeClient(answer: string) {
	const client = {
		ended: 0,
		commands: [] as string[],
		end() {
			client.ended++;
		},
		exec(command: string, cb: (err: undefined, stream: unknown) => void) {
			client.commands.push(command);
			const stream = Object.assign(new EventEmitter(), {
				stderr: new EventEmitter(),
				end() {
					setImmediate(() => {
						if (answer) stream.emit("data", Buffer.from(answer));
						stream.emit("close", 0);
					});
				},
			});
			cb(undefined, stream);
		},
	};
	return client;
}

describe("withSharedHost", () => {
	test("overlapping asks share one connection, closed after the last", async () => {
		const clients: ReturnType<typeof fakeClient>[] = [];
		const connect = async () => {
			const client = fakeClient("");
			clients.push(client);
			return client as unknown as Client;
		};
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = withSharedHost(host, () => held.then(() => "a"), connect);
		const second = withSharedHost(host, async () => "b", connect);
		expect(await second).toBe("b");
		expect(clients).toHaveLength(1);
		expect(clients[0]?.ended).toBe(0);
		release();
		expect(await first).toBe("a");
		expect(clients[0]?.ended).toBe(1);
		// The next ask, with nobody on the connection, opens a new one.
		expect(await withSharedHost(host, async () => "c", connect)).toBe("c");
		expect(clients).toHaveLength(2);
		expect(clients[1]?.ended).toBe(1);
	});

	test("a failed connect fails the asks on it and is not kept", async () => {
		let attempts = 0;
		const connect = async () => {
			attempts++;
			throw new Error("no route");
		};
		await expect(
			withSharedHost(host, async () => "x", connect),
		).rejects.toThrow("no route");
		await expect(
			withSharedHost(host, async () => "x", connect),
		).rejects.toThrow("no route");
		expect(attempts).toBe(2);
	});
});

describe("hostHasConversation", () => {
	test("yes when the host lists the session's transcript, no when it prints nothing", async () => {
		const found = fakeClient(
			"/home/odin-dan/.claude/projects/-home-x/abc.jsonl\n",
		);
		expect(
			await hostHasConversation(
				host,
				"abc",
				async () => found as unknown as Client,
			),
		).toBe(true);
		expect(found.commands[0]).toContain("'abc.jsonl'");
		expect(found.ended).toBe(1);
		const none = fakeClient("");
		expect(
			await hostHasConversation(
				host,
				"abc",
				async () => none as unknown as Client,
			),
		).toBe(false);
	});

	test("an unreachable host is an error, not a no", async () => {
		await expect(
			hostHasConversation(host, "abc", async () => {
				throw new Error("SSM timed out");
			}),
		).rejects.toThrow("SSM timed out");
	});
});
