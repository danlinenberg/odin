import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
	HOST_SERVICE_PY,
	hostGithubLoginFile,
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

// A GitHub token endpoint of our own: each refresh rotates the pair.
const refreshes: string[] = [];
let issued = 0;
const github = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: async (req) => {
		refreshes.push(await req.text());
		issued += 1;
		return Response.json({
			access_token: `gho_new${issued}`,
			refresh_token: `ghr_${issued + 1}`,
			expires_in: 28_800,
		});
	},
});
const pairFile = (login: string) =>
	join(dir, "github", hostGithubLoginFile(login));
const token = (query: string, rejected?: string) =>
	fetch(`${url}/token?${query}`, {
		method: rejected ? "POST" : "GET",
		body: rejected,
	});

beforeAll(async () => {
	if (!live) return;
	writeFileSync(
		join(dir, "tokens.json"),
		JSON.stringify({
			slack: "xoxp-test",
			githubLogin: "dan-work",
			githubAccounts: { other: "gho_copy" },
		}),
	);
	mkdirSync(join(dir, "github"));
	writeFileSync(join(dir, "svc.py"), HOST_SERVICE_PY);
	proc = Bun.spawn(
		[
			"python3",
			join(dir, "svc.py"),
			userInfo().username,
			join(dir, "tokens.json"),
			String(PORT),
		],
		{
			stderr: "pipe",
			env: {
				PATH: process.env.PATH,
				ODIN_GITHUB_TOKEN_URL: `http://127.0.0.1:${github.port}/token`,
			},
		},
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
afterAll(() => {
	proc?.kill();
	github.stop(true);
});

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

	test("a session's GitHub token: the host's own sign-in while it has time left", async () => {
		writeFileSync(
			pairFile("dan-work"),
			JSON.stringify({
				access_token: "gho_live",
				refresh_token: "ghr_1",
				expires_at: Date.now() / 1000 + 3600,
				client_id: "Ov23host",
			}),
		);
		const res = await token("service=github&login=dan-work");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("gho_live");
		expect(refreshes).toHaveLength(0);
		// No login named: the default account's.
		expect(await (await token("service=github")).text()).toBe("gho_live");
	});

	test("near expiry it is refreshed first, and the rotated pair is what the host keeps", async () => {
		writeFileSync(
			pairFile("dan-work"),
			JSON.stringify({
				access_token: "gho_old",
				refresh_token: "ghr_1",
				expires_at: Date.now() / 1000 + 20 * 60,
				client_id: "Ov23host",
			}),
		);
		expect(await (await token("service=github&login=dan-work")).text()).toBe(
			"gho_new1",
		);
		expect(refreshes).toEqual([
			"client_id=Ov23host&grant_type=refresh_token&refresh_token=ghr_1",
		]);
		const kept = JSON.parse(readFileSync(pairFile("dan-work"), "utf8"));
		expect(kept.access_token).toBe("gho_new1");
		expect(kept.refresh_token).toBe("ghr_2");
		expect(kept.client_id).toBe("Ov23host");
		expect(kept.expires_at).toBeGreaterThan(Date.now() / 1000 + 28_000);
		// Fresh now: no second exchange.
		expect(await (await token("service=github&login=dan-work")).text()).toBe(
			"gho_new1",
		);
		expect(refreshes).toHaveLength(1);
	});

	test("GitHub refusing the token refreshes it once, not on every retry", async () => {
		expect(
			await (await token("service=github&login=dan-work", "gho_new1")).text(),
		).toBe("gho_new2");
		expect(refreshes).toHaveLength(2);
		expect(refreshes[1]).toContain("refresh_token=ghr_2");
		expect(
			await (await token("service=github&login=dan-work", "gho_new1")).text(),
		).toBe("gho_new2");
		expect(refreshes).toHaveLength(2);
	});

	test("an account with no sign-in of its own gets the laptop's copy, and a repo owner picks the account", async () => {
		expect(await (await token("service=github&login=other")).text()).toBe(
			"gho_copy",
		);
		expect(
			await (await token("service=github&login=dan-work&owner=Other")).text(),
		).toBe("gho_copy");
		// An owner the host has no account for: the session's own.
		expect(
			await (
				await token("service=github&login=dan-work&owner=imagenai")
			).text(),
		).toBe("gho_new2");
		// An account the host doesn't have: the default one's, as a launch picks.
		expect(await (await token("service=github&login=nobody")).text()).toBe(
			"gho_new2",
		);
	});

	test("the token endpoint takes GitHub logins only, for GitHub only", async () => {
		expect((await token("service=github&login=../tokens")).status).toBe(400);
		expect((await token("service=slack")).status).toBe(404);
		expect(
			(await fetch(`${url}/token?service=github`, { headers: { Origin: "x" } }))
				.status,
		).toBe(403);
	});

	test("no token for the account at all says where to turn it on", async () => {
		rmSync(pairFile("dan-work"));
		writeFileSync(join(dir, "tokens.json"), JSON.stringify({ slack: "x" }));
		const res = await token("service=github&login=dan-work");
		expect(res.status).toBe(404);
		expect(await res.text()).toContain("GitHub accounts on the host");
	});
});

test("setup gives each host user a service of their own, run by odin, which alone can read the tokens", () => {
	const script = hostServiceInstallScript("odin-dan");
	expect(script).toContain("'User=odin'");
	expect(script).toContain(
		"install -d -m 700 -o odin -g odin /var/lib/odin /var/lib/odin/odin-dan /var/lib/odin/odin-dan/github",
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
