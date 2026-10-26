import { SSMClient } from "@aws-sdk/client-ssm";
import { awsSignInNeeded } from "shared/host-setup";
import type { Client } from "ssh2";
import { SSM_UNSEEN, ssmPing } from "./aws-instances";
import { HOST_SERVICE_PY } from "./host-service";
import { SERVICE_CURRENT_SCRIPT } from "./host-tokens";
import { connectHost, type HostLogin, runOnHost } from "./ssh";
import { awsClientConfig, keyRefused, userMissing } from "./ssm";

/** ok: done. fail: sessions can't start until it's fixed. warn: they start, but something is off. skipped: an earlier step failed. */
export type HealthState = "ok" | "fail" | "warn" | "skipped";

export interface HealthCheck {
	id:
		| "claude"
		| "aws"
		| "ssm"
		| "user"
		| "login"
		| "tools"
		| "service"
		| "room";
	label: string;
	state: HealthState;
	/** What was found, and for a fail or warn, what fixes it. */
	detail: string;
	/** The button Settings shows beside a fail or warn that Odin can fix from there. */
	fix?: HealthFix;
}

/** claude/aws: sign in. setup: set up the user (Linux user, tools, service). start: start the stopped host. reboot: reboot it. */
export type HealthFix = "claude" | "aws" | "setup" | "start" | "reboot";

export interface HostHealth {
	/** No step failed: a new session can start on the host. */
	healthy: boolean;
	checks: HealthCheck[];
	at: number;
}

/** What the checks reach the host through - real AWS and SSH, or fakes in tests. */
export interface HealthProbe {
	awsSignedIn(): Promise<boolean>;
	/** SSM's ping status for the instance, or null when SSM has never seen it. */
	ssmStatus(): Promise<string | null>;
	/** Logs in as the host user and runs `command` there, `input` on its stdin. */
	login(): Promise<{
		run(command: string, input?: string): Promise<string>;
		end(): void;
	}>;
}

const LABELS: Record<HealthCheck["id"], string> = {
	claude: "Claude sign-in",
	aws: "AWS sign-in",
	ssm: "Host reachable over SSM",
	user: "Your Linux user on the host",
	login: "Login",
	tools: "Claude, tmux, git and gh",
	service: "Odin's service for you",
	room: "Memory and disk",
};
const ORDER = Object.keys(LABELS) as HealthCheck["id"][];

/** Prints the tools, the service's answer, free memory (kB) and free disk (kB), as name=value lines. */
export const HEALTH_SCRIPT = [
	'export PATH="$HOME/.local/bin:$HOME/.odin/bin:$PATH"',
	'for t in claude tmux git gh; do echo "$t=$(command -v $t || echo missing)"; done',
	'echo "service=$(curl -sf -m 5 "http://127.0.0.1:$((40000 + $(id -u) % 10000 * 2))/health" >/dev/null && echo up || echo down)"',
	"echo \"mem=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)\"",
	'echo "disk=$(df -Pk "$HOME" | awk \'NR==2 {print $4}\')"',
].join("\n");

/** `name=value` lines into a map. */
export function parseHealthOutput(output: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const line of output.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) found.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
	}
	return found;
}

const ADMIN_FIX =
	"Set it up - your AWS role needs to allow ssm:SendCommand on the host, so ask an administrator if it doesn't.";
const firstLine = (err: unknown) =>
	(err instanceof Error ? err.message : String(err))
		.split("\n")[0]
		.slice(0, 300);

/**
 * Walks what a new session on the host needs, in the order a session needs
 * it, and says which step is missing and how to fix it. A failed step skips
 * the ones after it that need it. Asks for no sign-in itself: an expired one
 * is reported, not renewed.
 */
export async function checkHostHealth(
	host: HostLogin & { profile?: string | null },
	hasClaudeToken: boolean,
	probe: HealthProbe,
): Promise<HostHealth> {
	const checks = new Map<
		HealthCheck["id"],
		Omit<HealthCheck, "id" | "label">
	>();
	const set = (
		id: HealthCheck["id"],
		state: HealthState,
		detail: string,
		fix?: HealthFix,
	) => checks.set(id, { state, detail, ...(fix && { fix }) });
	const done = (): HostHealth => {
		const list = ORDER.map((id) => ({
			id,
			label: LABELS[id],
			...(checks.get(id) ?? { state: "skipped" as const, detail: "" }),
		}));
		return {
			healthy: list.every((check) => check.state !== "fail"),
			checks: list,
			at: Date.now(),
		};
	};

	set(
		"claude",
		hasClaudeToken ? "ok" : "fail",
		hasClaudeToken
			? "Saved on this computer."
			: "No Claude sign-in saved. Sign in and approve Claude in the browser.",
		hasClaudeToken ? undefined : "claude",
	);

	const profile = host.profile || "default";
	if (!(await probe.awsSignedIn().catch(() => false))) {
		set(
			"aws",
			"fail",
			`The AWS sign-in for the ${profile} profile is missing or expired. Sign in and approve it in your browser.`,
			"aws",
		);
		return done();
	}
	set("aws", "ok", `Signed in with the ${profile} profile.`);

	const ping = await probe.ssmStatus().catch(() => "error");
	if (ping !== "Online") {
		set(
			"ssm",
			"fail",
			ping === "error"
				? "Could not ask SSM about the host. Your AWS role may not allow ssm:DescribeInstanceInformation."
				: ping
					? `SSM reports ${host.instanceId} as ${ping}: it is stopped, rebooting or cut off. Start it.`
					: `SSM does not list ${host.instanceId}: it was never set up for SSM, it is gone, or your AWS role can't see it. ${SSM_UNSEEN}`,
			ping && ping !== "error" ? "start" : undefined,
		);
		return done();
	}
	set("ssm", "ok", `${host.instanceId} is online.`);

	let session: Awaited<ReturnType<HealthProbe["login"]>>;
	try {
		session = await probe.login();
	} catch (err) {
		if (userMissing(err)) {
			set(
				"user",
				"fail",
				`${host.instanceId} has no Linux user ${host.user}, so Odin can't log in as you. ${ADMIN_FIX}`,
				"setup",
			);
		} else if (awsSignInNeeded(err)) {
			set(
				"aws",
				"fail",
				`The AWS sign-in for the ${profile} profile expired during the check. Sign in and approve it in your browser.`,
				"aws",
			);
		} else {
			set(
				"user",
				"ok",
				`${host.user} may exist; the login did not get far enough to tell.`,
			);
			set(
				"login",
				"fail",
				keyRefused(err)
					? "The host refused Odin's one-time key. A host out of memory does this: reboot it. If it keeps happening, your user may be missing its setup."
					: `Could not log in: ${firstLine(err)}`,
				keyRefused(err) ? "reboot" : undefined,
			);
		}
		return done();
	}
	set("user", "ok", `${host.user} exists.`);
	set("login", "ok", "Logged in over SSM with a one-time key.");

	try {
		const found = parseHealthOutput(await session.run(HEALTH_SCRIPT));
		const missing = ["claude", "tmux", "git"].filter(
			(tool) => (found.get(tool) ?? "missing") === "missing",
		);
		const noGh = (found.get("gh") ?? "missing") === "missing";
		if (missing.length)
			set(
				"tools",
				"fail",
				`Missing for ${host.user}: ${missing.join(", ")}. ${ADMIN_FIX}`,
				"setup",
			);
		else if (noGh)
			set(
				"tools",
				"warn",
				"gh is missing: sessions there can't open pull requests. It comes with the next session's setup.",
			);
		else set("tools", "ok", "All installed.");

		const current = await session
			.run(SERVICE_CURRENT_SCRIPT(host.user), HOST_SERVICE_PY)
			.catch(() => "");
		const up = found.get("service") === "up";
		if (!up)
			set(
				"service",
				"warn",
				`Not answering, so connectors and GitHub tokens don't reach sessions there and they can't reach Odin here. ${ADMIN_FIX}`,
				"setup",
			);
		else if (current !== "current")
			set(
				"service",
				"warn",
				`Running an older version than this Odin. It updates itself when an administrator's Odin sends tokens; else ${ADMIN_FIX.charAt(0).toLowerCase()}${ADMIN_FIX.slice(1)}`,
				"setup",
			);
		else set("service", "ok", "Running, and up to date.");

		const memMb = Math.round(Number(found.get("mem") ?? 0) / 1024);
		const diskGb =
			Math.round(Number(found.get("disk") ?? 0) / 1024 / 102.4) / 10;
		const low = [
			memMb < 500 ? `${memMb} MB memory free` : "",
			diskGb < 2 ? `${diskGb} GB disk free` : "",
		].filter(Boolean);
		set(
			"room",
			low.length ? "warn" : "ok",
			low.length
				? `Only ${low.join(" and ")}: new sessions may stall. End sessions you're done with, or reboot the host.`
				: `${memMb} MB memory and ${diskGb} GB disk free.`,
			low.length ? "reboot" : undefined,
		);
	} catch (err) {
		set(
			"tools",
			"fail",
			`The check could not run on the host: ${firstLine(err)}`,
		);
	} finally {
		session.end();
	}
	return done();
}

/** Rejects after `ms`, so a hung host can't hang the check. */
function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/** The real probe: the host's AWS profile, SSM and an SSH login as the host user. */
export function hostProbe(host: HostLogin): HealthProbe {
	const config = awsClientConfig(host);
	return {
		awsSignedIn: () =>
			config.credentials().then(
				() => true,
				() => false,
			),
		ssmStatus: async () =>
			(await ssmPing(new SSMClient(config), [host.instanceId])).get(
				host.instanceId,
			) ?? null,
		login: async () => {
			const client: Client = await within(
				120_000,
				"The login",
				connectHost(host),
			);
			return {
				run: (command, input) =>
					within(60_000, "The check", runOnHost(client, command, input)),
				end: () => client.end(),
			};
		},
	};
}
