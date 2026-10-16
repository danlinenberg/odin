import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initTRPC } from "@trpc/server";
import superjson from "superjson";

// The gate is under test, not the board: a stand-in router.
const t = initTRPC.create({ transformer: superjson });
mock.module("./router", () => ({
	phoneRouter: t.router({ board: t.procedure.query(() => "ok") }),
}));
const { phoneConfig, setPhoneEnabled } = await import("./server");
// Not ~/.odin, and not by mocking app-environment: a module mock leaks into
// every later test file in the run.
phoneConfig.file = join(
	mkdtempSync(join(tmpdir(), "odin-phone-")),
	"phone.json",
);

afterAll(() => setPhoneEnabled(false));

test("the phone's API needs the token from the QR code", async () => {
	const status = await setPhoneEnabled(true);
	if (status.state !== "on") throw new Error(JSON.stringify(status));
	const url = new URL(status.url);
	const token = url.searchParams.get("t");
	const api = `http://127.0.0.1:${url.port}/trpc/board`;

	expect((await fetch(api)).status).toBe(401);
	const wrong = { authorization: "Bearer nope" };
	expect((await fetch(api, { headers: wrong })).status).toBe(401);
	const right = { authorization: `Bearer ${token}` };
	expect((await fetch(api, { headers: right })).status).not.toBe(401);
});

test("off closes the port", async () => {
	const status = await setPhoneEnabled(true);
	if (status.state !== "on") throw new Error(JSON.stringify(status));
	const port = new URL(status.url).port;
	await setPhoneEnabled(false);
	expect(fetch(`http://127.0.0.1:${port}/trpc/board`)).rejects.toThrow();
});
