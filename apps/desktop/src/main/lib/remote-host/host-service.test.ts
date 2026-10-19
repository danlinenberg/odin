import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HOST_SERVICE_PORT,
	HOST_SERVICE_PY,
	HOST_TOKENS_FILE,
	hostServiceInstallScript,
	LAPTOP_TUNNEL_PORT,
} from "./host-service";

// The real service, on spare ports, with a token file of its own.
const PORT = 40_000 + Math.floor(Math.random() * 10_000);
const dir = mkdtempSync(join(tmpdir(), "odin-host-service-"));
let proc: ReturnType<typeof Bun.spawn> | undefined;
const url = `http://127.0.0.1:${PORT}`;
const post = (
	form: Record<string, string>,
	headers: Record<string, string> = {},
) =>
	fetch(`${url}/odin`, {
		method: "POST",
		headers,
		body: new URLSearchParams(form),
	});

beforeAll(async () => {
	if (!live) return;
	writeFileSync(
		join(dir, "tokens.json"),
		JSON.stringify({ slack: "xoxp-test" }),
	);
	const script = HOST_SERVICE_PY.replace(
		HOST_TOKENS_FILE,
		join(dir, "tokens.json"),
	)
		.replace(String(HOST_SERVICE_PORT), String(PORT))
		.replace(String(LAPTOP_TUNNEL_PORT), String(PORT + 1));
	writeFileSync(join(dir, "svc.py"), script);
	proc = Bun.spawn(["python3", join(dir, "svc.py")], { stderr: "pipe" });
	for (let i = 0; i < 30; i++) {
		if (
			await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) }).then(
				(r) => r.ok,
				() => false,
			)
		)
			return;
		await Bun.sleep(100);
	}
	proc.kill();
	const why = await new Response(proc.stderr as ReadableStream).text();
	throw new Error(`Odin's host service didn't start: ${why.slice(-500)}`);
}, 20_000);
afterAll(() => proc?.kill());

// The service is for Linux hosts. CI's macOS runners start python3 but never
// let it answer on a local port, so the live checks run everywhere else.
const live = !(process.env.CI && process.platform === "darwin");

describe.skipIf(!live)("Odin's host service", () => {
	test("refuses browsers, and keeps calls inside the service's API", async () => {
		expect(
			(await post({ action: "service" }, { Origin: "https://x.example" }))
				.status,
		).toBe(403);
		expect(
			await (
				await post({
					action: "service",
					service: "slack",
					path: "https://x.example/a",
				})
			).text(),
		).toStartWith("path must be relative to https://slack.com/api/");
	});

	test("says which connectors aren't on the host, and when the laptop is asleep", async () => {
		expect(
			await (
				await post({ action: "service", service: "notion", path: "users/me" })
			).text(),
		).toStartWith("notion isn't on this host.");
		const asleep = await post({ action: "sessions" });
		expect(asleep.status).toBe(503);
	});
});

test("setup runs it as its own user, which alone can read the tokens", () => {
	expect(hostServiceInstallScript).toContain("'User=odin'");
	expect(hostServiceInstallScript).toContain(
		"install -d -m 700 -o odin -g odin /var/lib/odin",
	);
});
