import { expect, test } from "bun:test";

// The module reads the Capacitor bridge off window: none under test.
(globalThis as { window?: object }).window ??= {};
const { routedFetch, Unreachable } = await import("./odin-fetch");

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
	// What only the Mac does still fails as before.
	expect(fetch("/trpc/night")).rejects.toThrow("asleep");
	expect(fetch("/upload?ext=png")).rejects.toThrow("asleep");
});

test("a Mac that got the request and was slow to answer is not retried on the host", async () => {
	const { calls, fetch } = setup(new TypeError("Odin is slow to answer."));
	expect(fetch("/trpc/reply")).rejects.toThrow("slow");
	await Bun.sleep(0);
	expect(calls).toEqual(["mac /trpc/reply"]);
});
