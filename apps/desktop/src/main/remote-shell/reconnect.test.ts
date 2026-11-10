import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import { Client } from "ssh2";
import {
	keepAttached,
	MAX_TRIES,
	type ReconnectIo,
	STUCK_RETRY_MAX_MS,
	STUCK_RETRY_MS,
	type StuckChoice,
	settleWithin,
	untilReady,
} from "./reconnect";

/** A loop with no real waits: pauses resolve at once, time is a counter. */
function fakeIo(over: Partial<ReconnectIo<string>>) {
	const said: string[] = [];
	const stuck: string[] = [];
	let clock = 0;
	const io: ReconnectIo<string> = {
		connect: async () => "client",
		attach: async () => false,
		pause: async () => false,
		reboot: async () => {},
		stuck: async (reason) => {
			stuck.push(reason);
			return "retry";
		},
		say: (text) => said.push(text),
		fatal: () => false,
		now: () => clock,
		random: () => 0,
		...over,
	};
	return { io, said, stuck, tick: (ms: number) => (clock += ms) };
}

describe("keepAttached", () => {
	test("a host that is up but loses every attach stops after MAX_TRIES with the reason, instead of reconnecting forever", async () => {
		let attaches = 0;
		let picks = 0;
		const { io, said, stuck } = fakeIo({
			attach: async () => {
				attaches++;
				// Once you picked from the stopped state, the session comes back.
				if (picks > 0) return false;
				throw new Error("exit 1");
			},
			stuck: async (reason) => {
				stuck.push(reason);
				picks++;
				return "retry";
			},
		});
		await keepAttached(io, "i-0abc");
		expect(stuck).toEqual(["could not attach: exit 1"]);
		expect(attaches).toBe(MAX_TRIES + 1);
		// Every failed try said when the next one comes.
		expect(
			said.filter((line) =>
				/^could not attach: exit 1 - trying again in/.test(line),
			),
		).toHaveLength(MAX_TRIES - 1);
	});

	test("an attach that drops right away counts as a failed try; one that held for a while does not", async () => {
		let attaches = 0;
		const { io, stuck, tick } = fakeIo({
			attach: async () => {
				attaches++;
				if (attaches === 1) {
					tick(10 * 60_000);
					return true;
				}
				return attaches <= MAX_TRIES + 1;
			},
			stuck: async (reason) => {
				stuck.push(reason);
				return "retry";
			},
		});
		await keepAttached(io, "i-0abc");
		expect(stuck).toEqual([
			"could not reconnect: the session on i-0abc dropped right away",
		]);
	});

	test("a login that keeps failing ends in the stopped state, and F starts Claude over on the next attach", async () => {
		let connects = 0;
		const fresh: boolean[] = [];
		const { io, stuck } = fakeIo({
			connect: async () => {
				connects++;
				if (connects <= MAX_TRIES) throw new Error("SSM session ended");
				return "client";
			},
			attach: async (_client, _first, isFresh) => {
				fresh.push(isFresh);
				return false;
			},
			stuck: async (reason): Promise<StuckChoice> => {
				stuck.push(reason);
				return "fresh";
			},
		});
		await keepAttached(io, "i-0abc");
		expect(stuck).toEqual(["could not reconnect: SSM session ended"]);
		expect(fresh).toEqual([true]);
	});

	test("a pick from the stopped state puts a new connect line on screen, so Retry and Start over take effect at once", async () => {
		let connects = 0;
		const { io, said } = fakeIo({
			connect: async () => {
				connects++;
				if (connects <= MAX_TRIES) throw new Error("logging in timed out");
				return "client";
			},
		});
		await keepAttached(io, "i-0abc");
		expect(said.at(-1)).toBe("connecting to i-0abc...");
	});

	test("left alone, the stopped state tries once by itself, waiting longer after each miss, and a host that comes back is picked up", async () => {
		let connects = 0;
		const waits: number[] = [];
		const counts: number[] = [];
		const { io, said } = fakeIo({
			connect: async () => {
				connects++;
				// Down for the first round and four of the stopped state's own tries.
				if (connects <= MAX_TRIES + 4) throw new Error("timed out");
				return "client";
			},
			stuck: async (_reason, tries, retryInMs) => {
				counts.push(tries);
				waits.push(retryInMs);
				return "auto";
			},
		});
		await keepAttached(io, "i-0abc");
		expect(waits).toEqual([
			STUCK_RETRY_MS,
			STUCK_RETRY_MS * 2,
			STUCK_RETRY_MS * 4,
			STUCK_RETRY_MAX_MS,
			STUCK_RETRY_MAX_MS,
		]);
		// Each of its own tries is one login, counted on from the round before.
		expect(counts).toEqual([6, 7, 8, 9, 10]);
		expect(connects).toBe(MAX_TRIES + 5);
		// No "trying again in 10s" lines between its own tries.
		expect(
			said.filter((line) => line.includes("trying again in")),
		).toHaveLength(MAX_TRIES - 1);
	});

	test("Retry from the stopped state starts a full round again, and its own retry back at the first wait", async () => {
		let connects = 0;
		const waits: number[] = [];
		const picks: StuckChoice[] = ["auto", "retry"];
		const { io } = fakeIo({
			connect: async () => {
				connects++;
				if (connects <= MAX_TRIES + 1 + MAX_TRIES) throw new Error("timed out");
				return "client";
			},
			stuck: async (_reason, _tries, retryInMs) => {
				waits.push(retryInMs);
				return picks.shift() ?? "retry";
			},
		});
		await keepAttached(io, "i-0abc");
		expect(waits).toEqual([STUCK_RETRY_MS, STUCK_RETRY_MS * 2, STUCK_RETRY_MS]);
	});

	test("a failure no retry fixes ends the pane", async () => {
		const { io } = fakeIo({
			connect: async () => {
				throw new Error("AccessDenied");
			},
			fatal: () => true,
		});
		await expect(keepAttached(io, "i-0abc")).rejects.toThrow("AccessDenied");
	});
});

describe("untilReady", () => {
	test("a connection that closes before the login finished rejects, instead of waiting forever", async () => {
		// ssh2 does exactly this when the SSM stream ends cleanly before the
		// handshake: "close", no "error", and its ready timeout cleared.
		const client = new EventEmitter();
		let failed = 0;
		const ready = untilReady(client, () => failed++);
		client.emit("close");
		await expect(ready).rejects.toThrow(
			"the host closed the connection before the login finished",
		);
		expect(failed).toBe(1);
	});

	for (const destroyed of [false, true])
		test(`ssh2 itself: sshd greets, then the SSM stream ends${destroyed ? " and is destroyed" : ""} - no error, so only this ends the login`, async () => {
			// The SSM stream as openSsmStream builds it, ending as it does when
			// the plugin exits 0 or sshd drops the connection after its greeting.
			const fromHost = new PassThrough();
			const sock = Duplex.from({
				readable: fromHost,
				writable: new PassThrough(),
			});
			sock.on("error", () => {});
			const client = new Client();
			const errors: Error[] = [];
			client.on("error", (err) => errors.push(err));
			const outcome = untilReady(client, () => {}).then(
				() => "ready",
				(err: Error) => err.message,
			);
			client.connect({ sock, username: "odin-x", readyTimeout: 60_000 });
			fromHost.write("SSH-2.0-OpenSSH_9.6\r\n");
			await new Promise((resolve) => setTimeout(resolve, 20));
			fromHost.end();
			if (destroyed) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				sock.destroy();
			}
			expect(await outcome).toBe(
				"the host closed the connection before the login finished",
			);
			// What the old login waited on, besides ready: it never came.
			expect(errors).toEqual([]);
		});

	test("resolves on ready, and a later close is no failure", async () => {
		const client = new EventEmitter();
		let failed = 0;
		const ready = untilReady(client, () => failed++);
		client.emit("ready");
		client.emit("close");
		await ready;
		expect(failed).toBe(0);
	});
});

describe("settleWithin", () => {
	test("a step that never answers times out, and a late answer is discarded", async () => {
		let finish: (value: string) => void = () => {};
		const work = new Promise<string>((resolve) => {
			finish = resolve;
		});
		const discarded: string[] = [];
		await expect(
			settleWithin(5, "logging in to i-0abc", work, (late) =>
				discarded.push(late),
			),
		).rejects.toThrow("logging in to i-0abc timed out");
		finish("client");
		await work;
		await Promise.resolve();
		expect(discarded).toEqual(["client"]);
	});
});
