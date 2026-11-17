import { expect, test } from "bun:test";

// The module reads the Capacitor bridge off window: none under test.
(globalThis as { window?: object }).window ??= {};
const { hostOnlyFetch, routedFetch, Silent, Unpaired, Unreachable } =
	await import("./odin-fetch");

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
	return { calls, fetch: routedFetch(mac, () => host) };
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
	// A photo goes to the host too, for a reply to a session there.
	expect(await (await fetch("/upload?ext=png")).text()).toBe("host");
});

test("no host paired: what the Mac's failure says stands", async () => {
	const fetch = routedFetch(
		async () => {
			throw new Unreachable("asleep");
		},
		() => null,
	);
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
		() => async () => new Response(null, { status: 401 }),
		() => {
			forgot++;
		},
	);
	const error = await fetch("/trpc/board").catch((e) => e);
	expect(error).toBeInstanceOf(Unreachable);
	expect(error.message).toContain("Your Mac is away");
	expect(forgot).toBe(1);
});

/** A Mac whose channel opens after `opensIn` ms, or never (null), or refuses. */
function reachable(opensIn: number | null, refuses = false) {
	const calls: string[] = [];
	let looks = 0;
	const mac = Object.assign(
		async (input: RequestInfo | URL) => {
			calls.push(`mac ${String(input)}`);
			if (refuses) return new Response(null, { status: 401 });
			return ok("mac");
		},
		{
			reach: async () => {
				looks++;
				if (refuses) throw new Unpaired("no");
				if (opensIn === null) throw new Error("asleep");
				// An open channel is there at once the next time.
				if (looks === 1) await Bun.sleep(opensIn);
			},
		},
	);
	const host = async (input: RequestInfo | URL) => {
		calls.push(`host ${String(input)}`);
		return ok("host");
	};
	return { calls, mac, host, looks: () => looks };
}

test("a Mac that doesn't open in time: the host answers, and the Mac takes over once it's there", async () => {
	const { calls, mac, host, looks } = reachable(2_700);
	const fetch = routedFetch(mac, () => host);
	const started = Date.now();
	expect(await (await fetch("/trpc/board")).text()).toBe("host");
	expect(Date.now() - started).toBeLessThan(2_650);
	// Away: the host answers at once, with no second look while one runs.
	expect(await (await fetch("/trpc/board")).text()).toBe("host");
	expect(looks()).toBe(1);
	await Bun.sleep(300);
	expect(await (await fetch("/trpc/board")).text()).toBe("mac");
	expect(calls).toEqual([
		"host /trpc/board",
		"host /trpc/board",
		"mac /trpc/board",
	]);
});

test("a Mac that can't be reached is never sent the request", async () => {
	const { calls, mac, host } = reachable(null);
	const fetch = routedFetch(mac, () => host);
	expect(await (await fetch("/trpc/reply", { method: "POST" })).text()).toBe(
		"host",
	);
	expect(calls).toEqual(["host /trpc/reply"]);
});

test("a Mac that unpaired this phone answers for itself: the host is not asked", async () => {
	const { calls, mac, host } = reachable(0, true);
	expect((await routedFetch(mac, () => host)("/trpc/board")).status).toBe(401);
	expect(calls).toEqual(["mac /trpc/board"]);
});

test("a read the Mac never answered goes to the host; a reply does not", async () => {
	const asked: string[] = [];
	const fetch = routedFetch(
		async () => {
			throw new Silent("Odin didn't answer. Reconnecting.");
		},
		() => async (input) => {
			asked.push(String(input));
			return ok("host");
		},
	);
	expect(fetch("/trpc/reply", { method: "POST" })).rejects.toThrow(
		"didn't answer",
	);
	expect(await (await fetch("/trpc/board")).text()).toBe("host");
	expect(asked).toEqual(["/trpc/board"]);
});

test("the host is read at each request: another profile's host answers after a switch", async () => {
	let picked = "work";
	const fetch = routedFetch(
		async () => {
			throw new Unreachable("asleep");
		},
		() => async () => ok(picked),
	);
	expect(await (await fetch("/trpc/board")).text()).toBe("work");
	picked = "personal";
	expect(await (await fetch("/trpc/board")).text()).toBe("personal");
});

test("a cluster: the board lists every host's sessions, and each session's calls go to its host", async () => {
	const superjson = (await import("superjson")).default;
	const { clusterFetch } = await import("./odin-fetch");
	const calls: string[] = [];
	const host =
		(name: string, panes: string[]) => async (input: RequestInfo | URL) => {
			calls.push(`${name} ${String(input)}`);
			const path = String(input);
			if (!path.includes("board")) return ok(name);
			const data = superjson.serialize({
				sessions: panes.map((paneId) => ({ paneId, night: undefined })),
				backlog: [{ id: `${name}-task` }],
			});
			const result = { result: { data } };
			return new Response(
				JSON.stringify(path.includes("batch=1") ? [{}, result] : result),
				{ status: 200 },
			);
		};
	const down = async () => {
		throw new Unreachable("down");
	};
	const fetch = clusterFetch(host("main", ["p1"]), [host("two", ["p2"]), down]);
	const answer = await (await fetch("/trpc/profiles,board?batch=1")).json();
	const board = superjson.deserialize<{
		sessions: { paneId: string }[];
		backlog: { id: string }[];
	}>(answer[1].result.data);
	expect(board.sessions.map((s) => s.paneId)).toEqual(["p1", "p2"]);
	// The backlog is the main host's alone.
	expect(board.backlog).toEqual([{ id: "main-task" }]);
	calls.length = 0;
	const input = encodeURIComponent(JSON.stringify({ json: { paneId: "p2" } }));
	expect(await (await fetch(`/trpc/session?input=${input}`)).text()).toBe(
		"two",
	);
	expect(
		await (
			await fetch("/trpc/reply", {
				method: "POST",
				body: JSON.stringify({ json: { paneId: "p1", text: "hi" } }),
			})
		).text(),
	).toBe("main");
	expect(await (await fetch("/upload?ext=png&pane=p2")).text()).toBe("two");
	expect(await (await fetch("/trpc/add")).text()).toBe("main");
	expect(calls.every((call) => !call.includes("board"))).toBe(true);
});
