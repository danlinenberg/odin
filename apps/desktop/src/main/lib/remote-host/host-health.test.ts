import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	checkHostHealth,
	HEALTH_SCRIPT,
	type HealthProbe,
	parseHealthOutput,
} from "./host-health";

const host = {
	instanceId: "i-0abc",
	profile: "dev",
	user: "odin-dan",
};

const GOOD_OUTPUT = [
	"claude=/home/odin-dan/.local/bin/claude",
	"tmux=/usr/bin/tmux",
	"git=/usr/bin/git",
	"gh=/home/odin-dan/.local/bin/gh",
	"service=up",
	"mem=4194304",
	"disk=20971520",
].join("\n");

function probe(overrides: Partial<HealthProbe> = {}, output = GOOD_OUTPUT) {
	return {
		awsSignedIn: async () => true,
		ssmStatus: async () => "Online",
		canReboot: async () => true,
		updateService: async () => {},
		login: async () => ({
			run: async (command: string) =>
				command === HEALTH_SCRIPT ? output : "current",
			end: () => {},
		}),
		...overrides,
	} satisfies HealthProbe;
}

const states = (health: Awaited<ReturnType<typeof checkHostHealth>>) =>
	Object.fromEntries(health.checks.map((check) => [check.id, check.state]));

test("a host with everything in place is healthy", async () => {
	const health = await checkHostHealth(host, true, probe());
	expect(health.healthy).toBe(true);
	expect(Object.values(states(health)).every((s) => s === "ok")).toBe(true);
	expect(health.checks.some((check) => check.fix)).toBe(false);
});

test("a missing Linux user fails that step, offers Set up, and skips the rest", async () => {
	const health = await checkHostHealth(
		host,
		true,
		probe({
			login: async () => {
				throw new Error(
					"The login key did not reach i-0abc (Failed): id: 'odin-dan': no such user",
				);
			},
		}),
	);
	expect(health.healthy).toBe(false);
	expect(states(health)).toMatchObject({
		aws: "ok",
		ssm: "ok",
		user: "fail",
		login: "skipped",
		tools: "skipped",
	});
	const user = health.checks.find((check) => check.id === "user");
	expect(user?.fix).toBe("setup");
});

test("an expired AWS sign-in stops before SSM", async () => {
	let asked = false;
	const health = await checkHostHealth(
		host,
		true,
		probe({
			awsSignedIn: async () => false,
			ssmStatus: async () => {
				asked = true;
				return "Online";
			},
		}),
	);
	expect(asked).toBe(false);
	expect(states(health)).toMatchObject({ aws: "fail", ssm: "skipped" });
	expect(health.checks.find((c) => c.id === "aws")?.fix).toBe("aws");
});

test("a stopped host offers Start, a refused key Reboot", async () => {
	const stopped = await checkHostHealth(
		host,
		true,
		probe({ ssmStatus: async () => "ConnectionLost" }),
	);
	expect(states(stopped).ssm).toBe("fail");
	expect(stopped.checks.find((c) => c.id === "ssm")?.fix).toBe("start");
	const refused = await checkHostHealth(
		host,
		true,
		probe({
			login: async () => {
				throw new Error("All configured authentication methods failed");
			},
		}),
	);
	expect(states(refused).login).toBe("fail");
	expect(refused.checks.find((c) => c.id === "login")?.fix).toBe("reboot");
});

test("an AWS role that may not reboot the host gets no Reboot, and is told to ask an administrator", async () => {
	const refused = await checkHostHealth(
		host,
		true,
		probe({
			canReboot: async () => false,
			login: async () => {
				throw new Error("All configured authentication methods failed");
			},
		}),
	);
	const login = refused.checks.find((c) => c.id === "login");
	expect(login?.fix).toBeUndefined();
	expect(login?.detail).toContain("ask an administrator to reboot it");
	const low = await checkHostHealth(
		host,
		true,
		probe(
			{ canReboot: async () => false },
			GOOD_OUTPUT.replace("mem=4194304", "mem=102400"),
		),
	);
	const room = low.checks.find((c) => c.id === "room");
	expect(room?.fix).toBeUndefined();
	expect(room?.detail).toContain("ask an administrator to reboot it");
});

test("no Claude sign-in fails; missing gh, a down service or low memory only warn", async () => {
	const output = GOOD_OUTPUT.replace(
		"gh=/home/odin-dan/.local/bin/gh",
		"gh=missing",
	)
		.replace("service=up", "service=down")
		.replace("mem=4194304", "mem=102400");
	const health = await checkHostHealth(host, false, probe({}, output));
	expect(health.healthy).toBe(false);
	expect(states(health)).toMatchObject({
		claude: "fail",
		tools: "warn",
		service: "warn",
		room: "warn",
	});
	expect(
		Object.fromEntries(health.checks.map((check) => [check.id, check.fix])),
	).toMatchObject({
		claude: "claude",
		tools: undefined,
		service: "setup",
		room: "reboot",
	});
	const ok = await checkHostHealth(host, true, probe({}, output));
	expect(ok.healthy).toBe(true);
});

test("the health script runs in sh and prints every value the check reads", () => {
	const found = parseHealthOutput(
		execFileSync("bash", ["-c", HEALTH_SCRIPT]).toString(),
	);
	for (const key of ["claude", "tmux", "git", "gh", "service", "mem", "disk"])
		expect(found.has(key)).toBe(true);
	expect(Number(found.get("disk"))).toBeGreaterThan(0);
});

test("an out-of-date service is updated during the check, and warns only when that fails", async () => {
	let updated = false;
	const login = async () => ({
		run: async (command: string) =>
			command === HEALTH_SCRIPT ? GOOD_OUTPUT : updated ? "current" : "",
		end: () => {},
	});
	const fixed = await checkHostHealth(
		host,
		true,
		probe({
			login,
			updateService: async () => {
				updated = true;
			},
		}),
	);
	expect(states(fixed).service).toBe("ok");

	updated = false;
	const denied = await checkHostHealth(
		host,
		true,
		probe({
			login,
			updateService: async () => {
				throw new Error("AccessDenied");
			},
		}),
	);
	expect(states(denied).service).toBe("warn");
});
