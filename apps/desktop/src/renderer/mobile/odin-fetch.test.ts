import { expect, test } from "bun:test";

// The module reads the Capacitor bridge off window: none under test.
(globalThis as { window?: object }).window ??= {};
const { hostOnlyFetch, routedFetch, Unreachable } = await import(
	"./odin-fetch"
);

const ok = (who: string) => new Response(who);

function setup(macFails: Error | null) {
	const calls: string[] = [];
	const mac = async (input: RequestInfo | URL) => {
		calls.push(`mac ${String(input)}`);
		if (macFails) throw macFails;
		return ok("mac");
	};
	const host = async (input: RequestInfo | URL) => {
		calls.push(`host ${String(input)}`);
		return ok("host");
	};
	return { calls, fetch: routedFetch(mac, host) };
}

test("the Mac answers while it's there; the host is never asked", async () => {
	const { calls, fetch } = setup(null);
	expect(await (await fetch("/trpc/reply")).text()).toBe("mac");
	expect(calls).toEqual(["mac /trpc/reply"]);
});

test("a Mac out of reach: the host answers what it can, and is asked first for a while", async () => {
	const { calls, fetch } = setup(new Unreachable("asleep"));
	expect(await (await fetch("/trpc/board,profiles?batch=1")).text()).toBe(
		"host",
	);
	expect(await (await fetch("/trpc/session?input=x")).text()).toBe("host");
	expect(calls).toEqual([
		"mac /trpc/board,profiles?batch=1",
		"host /trpc/board,profiles?batch=1",
		"host /trpc/session?input=x",
	]);
	// What only the Mac does says so, not "Couldn't connect".
	expect(fetch("/trpc/night")).rejects.toThrow("Your Mac is away");
	expect(fetch("/upload?ext=png")).rejects.toThrow("Your Mac is away");
});

test("no host paired: what the Mac's failure says stands", async () => {
	const fetch = routedFetch(async () => {
		throw new Unreachable("asleep");
	}, null);
	expect(fetch("/trpc/night")).rejects.toThrow("asleep");
});

test("paired with the host only: the host is asked what it answers, the rest says it needs the Mac", async () => {
	const calls: string[] = [];
	const fetch = hostOnlyFetch(async (input) => {
		calls.push(String(input));
		return ok("host");
	});
	expect(await (await fetch("/trpc/board,profiles?batch=1")).text()).toBe(
		"host",
	);
	expect(fetch("/trpc/night")).rejects.toThrow("needs Odin on your Mac");
	await Bun.sleep(0);
	expect(calls).toEqual(["/trpc/board,profiles?batch=1"]);
});

test("a Mac that got the request and was slow to answer is not retried on the host", async () => {
	const { calls, fetch } = setup(new TypeError("Odin is slow to answer."));
	expect(fetch("/trpc/reply")).rejects.toThrow("slow");
	await Bun.sleep(0);
	expect(calls).toEqual(["mac /trpc/reply"]);
});

test("a host that refuses the phone forgets its link, and never reads as the Mac unpairing it", async () => {
	let forgot = 0;
	const fetch = routedFetch(
		async () => {
			throw new Unreachable("asleep");
		},
		async () => new Response(null, { status: 401 }),
		() => {
			forgot++;
		},
	);
	const error = await fetch("/trpc/board").catch((e) => e);
	expect(error).toBeInstanceOf(Unreachable);
	expect(error.message).toContain("Your Mac is away");
	expect(forgot).toBe(1);
});
