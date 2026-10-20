import { describe, expect, test } from "bun:test";
import { createSlackClient, type SlackFetch } from "./slack-call";

type Reply = { status: number; retryAfter?: string; json: unknown };

function reply({ status, retryAfter, json }: Reply): Response {
	return new Response(JSON.stringify(json), {
		status,
		headers: retryAfter ? { "retry-after": retryAfter } : {},
	});
}

const ok: Reply = { status: 200, json: { ok: true } };
const limited: Reply = {
	status: 429,
	retryAfter: "60",
	json: { ok: false, error: "ratelimited" },
};

/** A fetch that answers from a script, one reply per call, in order. */
function scripted(replies: Reply[]) {
	const calls: string[] = [];
	const fetch: SlackFetch = async (url) => {
		calls.push(url);
		const next = replies.shift();
		if (!next) throw new Error(`unexpected fetch: ${url}`);
		return reply(next);
	};
	return { fetch, calls };
}

/** A sleep that only ends when the test releases it. */
function heldSleep() {
	const waits: { ms: number; release: () => void }[] = [];
	const sleep = (ms: number) =>
		new Promise<void>((release) => waits.push({ ms, release }));
	return { sleep, waits };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createSlackClient", () => {
	test("waits what Slack says and asks again", async () => {
		const { fetch, calls } = scripted([{ ...limited, retryAfter: "2" }, ok]);
		const slept: number[] = [];
		const client = createSlackClient({
			fetch,
			sleep: async (ms) => {
				slept.push(ms);
			},
		});
		await expect(
			client.call("reactions.get", { channel: "C1" }, "xoxp-1"),
		).resolves.toEqual({ ok: true });
		expect(slept).toEqual([2000]);
		expect(calls).toHaveLength(2);
	});

	test("a call waiting out a rate limit holds no slot", async () => {
		// One slot: the waiting call must give it up, or nothing else runs.
		const { fetch } = scripted([limited, ok, ok]);
		const { sleep, waits } = heldSleep();
		const client = createSlackClient({ fetch, sleep, slots: 1 });
		const history = client.call(
			"conversations.history",
			{ channel: "D1" },
			"xoxp-1",
		);
		await settle();
		expect(waits).toHaveLength(1);
		const gaveUp = new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error("auth.test never ran while history slept")),
				1000,
			),
		);
		await expect(
			Promise.race([client.call("auth.test", {}, "xoxp-1"), gaveUp]),
		).resolves.toEqual({ ok: true });
		waits[0]?.release();
		await expect(history).resolves.toEqual({ ok: true });
	});

	test("retry off: a rate limit is the answer, at once", async () => {
		const { fetch, calls } = scripted([limited]);
		const { sleep, waits } = heldSleep();
		const client = createSlackClient({ fetch, sleep });
		const gaveUp = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("still waiting on the limit")), 1000),
		);
		await expect(
			Promise.race([
				client.call("conversations.history", { channel: "D1" }, "xoxp-1", {
					retry: false,
				}),
				gaveUp,
			]),
		).rejects.toThrow("Slack conversations.history: ratelimited");
		expect(waits).toHaveLength(0);
		expect(calls).toHaveLength(1);
	});

	test("at most four calls are on the wire at once", async () => {
		const pending: ((res: Response) => void)[] = [];
		const fetch: SlackFetch = () =>
			new Promise((resolve) => {
				pending.push(resolve);
			});
		const client = createSlackClient({ fetch, sleep: async () => {} });
		const calls = Array.from({ length: 5 }, () =>
			client.call("users.info", { user: "U1" }, "xoxp-1"),
		);
		await settle();
		expect(pending).toHaveLength(4);
		pending[0]?.(reply(ok));
		await settle();
		expect(pending).toHaveLength(5);
		for (const resolve of pending.slice(1)) resolve(reply(ok));
		await Promise.all(calls);
	});

	test("invalid_auth is UNAUTHORIZED, any other refusal BAD_REQUEST", async () => {
		const { fetch } = scripted([
			{ status: 200, json: { ok: false, error: "invalid_auth" } },
			{ status: 200, json: { ok: false, error: "channel_not_found" } },
		]);
		const client = createSlackClient({ fetch, sleep: async () => {} });
		await expect(client.call("auth.test", {}, "xoxp-1")).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		await expect(
			client.call("conversations.info", { channel: "C1" }, "xoxp-1"),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "Slack conversations.info: channel_not_found",
		});
	});
});
