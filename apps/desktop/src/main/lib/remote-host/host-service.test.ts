import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
	HOST_SERVICE_PY,
	hostPorts,
	hostServiceInstallScript,
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
	writeFileSync(join(dir, "svc.py"), HOST_SERVICE_PY);
	proc = Bun.spawn(
		[
			"python3",
			join(dir, "svc.py"),
			userInfo().username,
			join(dir, "tokens.json"),
			String(PORT),
		],
		{ stderr: "pipe" },
	);
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

test("setup gives each host user a service of their own, run by odin, which alone can read the tokens", () => {
	const script = hostServiceInstallScript("odin-dan");
	expect(script).toContain("'User=odin'");
	expect(script).toContain(
		"install -d -m 700 -o odin -g odin /var/lib/odin /var/lib/odin/odin-dan",
	);
	expect(script).toContain(
		"host-service.py odin-dan /var/lib/odin/odin-dan/tokens.json $((40000 + $(id -u odin-dan) % 10000 * 2))",
	);
	expect(script).toContain("/etc/systemd/system/odin-host-odin-dan.service");
	expect(() => hostServiceInstallScript("x; rm -rf /")).toThrow();
});

test("each uid has its own pair of ports", () => {
	expect(hostPorts(1000)).toEqual({ service: 42000, tunnel: 42001 });
	expect(hostPorts(1001).service).toBe(42002);
});
