import { describe, expect, test } from "bun:test";
import {
	deliverOnHost,
	type HostDeps,
	type HostMessage,
} from "./host-delivery";

const RULE = "─".repeat(40);
const CLAUDE = `${RULE}\n❯\n${RULE}\n`;
const CONNECTING = "\nOdin: connecting to i-0abc123...\n";
const DROPPED = `${CLAUDE}\nOdin: connection lost - reconnecting to i-0abc123...\n`;
const BACK = `${DROPPED}${CLAUDE}`;

/** A pane on a fake clock: `screens` maps a start time (ms) to what it shows from then. */
function pane(screens: [number, string][], alive = () => true) {
	const clock = { now: 0 };
	const deps: HostDeps = {
		readScreen: async () =>
			screens.findLast(([from]) => clock.now >= from)?.[1] ?? "",
		sleep: async (ms) => {
			clock.now += ms;
			await Promise.resolve();
		},
		alive,
	};
	return { clock, deps };
}

/** A message that logs what happened to it, and arrives when `arrives` says so. */
function message(
	name: string,
	log: string[],
	clock: { now: number },
	arrives: (typedAt: number[]) => boolean = (typedAt) => typedAt.length > 0,
	deps?: HostDeps,
) {
	const typedAt: number[] = [];
	const msg: HostMessage = {
		type: async () => {
			log.push(`type ${name} @${clock.now}`);
			await deps?.sleep(100);
			typedAt.push(clock.now);
			log.push(`typed ${name}`);
		},
		arrived: () => arrives(typedAt),
		waiting: (on) => log.push(`${name} ${on ? "waiting" : "going in"}`),
		lost: () => log.push(`${name} lost`),
	};
	return { msg, typedAt };
}

describe("deliverOnHost", () => {
	test("a ready host gets the message at once", async () => {
		const { clock, deps } = pane([[0, CLAUDE]]);
		const log: string[] = [];
		const { msg, typedAt } = message("A", log, clock);
		await deliverOnHost("p1", msg, deps);
		expect(typedAt).toEqual([0]);
		expect(log).not.toContain("A lost");
	});

	test("a host down for five minutes gets the message once Claude is back, not in the connect step", async () => {
		const { clock, deps } = pane([
			[0, CONNECTING],
			[300_000, `${CONNECTING}${CLAUDE}`],
		]);
		const log: string[] = [];
		const { msg, typedAt } = message("A", log, clock);
		await deliverOnHost("p2", msg, deps);
		expect(typedAt.length).toBe(1);
		expect(typedAt[0]).toBeGreaterThanOrEqual(300_000);
		expect(log[0]).toBe("A waiting");
		expect(log).toContain("A going in");
		expect(log).not.toContain("A lost");
	});

	test("two messages sent while the host is down go in one at a time, in order", async () => {
		const { clock, deps } = pane([
			[0, CONNECTING],
			[5_000, `${CONNECTING}${CLAUDE}`],
		]);
		const log: string[] = [];
		const a = message("A", log, clock, undefined, deps);
		const b = message("B", log, clock, undefined, deps);
		await Promise.all([
			deliverOnHost("p3", a.msg, deps),
			deliverOnHost("p3", b.msg, deps),
		]);
		// B starts only after A finished typing.
		const typing = log
			.filter((line) => line.startsWith("type"))
			.map((line) => line.split(" @")[0]);
		expect(typing).toEqual(["type A", "typed A", "type B", "typed B"]);
		expect(a.typedAt.length).toBe(1);
		expect(b.typedAt.length).toBe(1);
		// B's bubble says it waits from the start, not only once A is in.
		expect(log.indexOf("B waiting")).toBeLessThan(log.indexOf("typed A"));
	});

	test("a message typed into a connection that then drops goes in again once the host is back", async () => {
		const { clock, deps } = pane([
			[0, CLAUDE],
			[20_000, DROPPED],
			[60_000, BACK],
		]);
		const log: string[] = [];
		// The first typing went into the dead connection; the second lands.
		const { msg, typedAt } = message("A", log, clock, (t) => t.length >= 2);
		await deliverOnHost("p4", msg, deps);
		expect(typedAt.length).toBe(2);
		expect(typedAt[1]).toBeGreaterThanOrEqual(60_000);
		expect(log.at(-1)).not.toBe("A lost");
	});

	test("a message Claude took while the transcript lagged is not typed twice", async () => {
		const { clock, deps } = pane([
			[0, CLAUDE],
			[20_000, DROPPED],
			[60_000, BACK],
		]);
		const log: string[] = [];
		// It shows up in the transcript only after the reconnect.
		const { msg, typedAt } = message(
			"A",
			log,
			clock,
			(t) => t.length > 0 && clock.now >= 61_000,
		);
		await deliverOnHost("p5", msg, deps);
		expect(typedAt.length).toBe(1);
		expect(log.at(-1)).not.toBe("A lost");
	});

	test("a message that still fails after the reconnect reads Not delivered", async () => {
		const { clock, deps } = pane([
			[0, CLAUDE],
			[20_000, DROPPED],
			[60_000, BACK],
		]);
		const log: string[] = [];
		const { msg, typedAt } = message("A", log, clock, () => false);
		await deliverOnHost("p6", msg, deps);
		expect(typedAt.length).toBe(2);
		expect(log.at(-1)).toBe("A lost");
	});

	test("a pane closed while it waits never gets typed into", async () => {
		// Closed a minute in.
		let reads = 0;
		const { clock, deps } = pane([[0, CONNECTING]], () => ++reads < 120);
		const log: string[] = [];
		const { msg, typedAt } = message("A", log, clock);
		await deliverOnHost("p7", msg, deps);
		expect(typedAt).toEqual([]);
		expect(log.at(-1)).toBe("A lost");
	});
});
