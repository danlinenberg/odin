import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Duplex } from "node:stream";
import { promisify } from "node:util";
import {
	EC2InstanceConnectClient,
	SendSSHPublicKeyCommand,
} from "@aws-sdk/client-ec2-instance-connect";
import {
	GetCommandInvocationCommand,
	SendCommandCommand,
	SSMClient,
	StartSessionCommand,
	TerminateSessionCommand,
} from "@aws-sdk/client-ssm";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { ODIN_HOME_DIR } from "../app-environment";

/**
 * SSH to an EC2 instance through AWS Systems Manager: no open port, no public
 * IP, no VPN and no key to manage. The user's own AWS sign-in opens the session;
 * AWS's session-manager-plugin carries the bytes, and ssh2 runs over them as
 * its `sock`. The plugin is downloaded once into Odin's folder - the user
 * installs nothing.
 */

export interface SsmTarget {
	instanceId: string;
	profile?: string | null;
	region?: string | null;
}

export const SSM_PLUGIN_VERSION = "1.2.896.0";

/** AWS's builds of this version, pinned by checksum: a swapped file is refused. */
const PLUGIN_BUILDS: Record<
	string,
	{ path: string; sha256: string; binary: string[] }
> = {
	"darwin-arm64": {
		path: "mac_arm64/sessionmanager-bundle.zip",
		sha256: "05c5ef53fb262de2fa1b46cf457890ee4152ec1dd8b2fdd94d028fa9b885ff36",
		binary: ["sessionmanager-bundle", "bin", "session-manager-plugin"],
	},
	"darwin-x64": {
		path: "mac/sessionmanager-bundle.zip",
		sha256: "66e826fd48a6a6d06ad06b0892805986f7c455295b61974f99cb2a43d29624d7",
		binary: ["sessionmanager-bundle", "bin", "session-manager-plugin"],
	},
	"win32-x64": {
		path: "windows/SessionManagerPlugin.zip",
		sha256: "b09adc18721b6e7a9888c98cb1a3aa55b681b8f12391fc1a983410cb1163f670",
		binary: ["package", "bin", "session-manager-plugin.exe"],
	},
};

const run = promisify(execFile);

/** An AWS client's region and credentials: the user's own profile, SSO included, or the default chain. */
export function awsClientConfig(target: {
	profile?: string | null;
	region?: string | null;
}) {
	return {
		region: target.region || undefined,
		// ignoreCache: the SDK keeps ~/.aws/config in memory for the life of
		// the process, so a profile changed after Odin started kept failing
		// on its old settings until Odin was restarted.
		credentials: fromNodeProviderChain({
			...(target.profile && { profile: target.profile }),
			ignoreCache: true,
		}),
	};
}

export function pluginBuild(platform: string, arch: string) {
	const build = PLUGIN_BUILDS[`${platform}-${arch}`];
	if (!build)
		throw new Error(
			`SSM connections are not available on ${platform} ${arch} yet.`,
		);
	return build;
}

/** The plugin's path, downloading and checking it on first use. */
export async function ensureSsmPlugin(
	home = ODIN_HOME_DIR,
	platform: string = process.platform,
	arch: string = process.arch,
): Promise<string> {
	const build = pluginBuild(platform, arch);
	const dir = path.join(
		home,
		"bin",
		`session-manager-plugin-${SSM_PLUGIN_VERSION}`,
	);
	const binary = path.join(dir, ...build.binary);
	if (fs.existsSync(binary)) return binary;

	const response = await fetch(
		`https://s3.amazonaws.com/session-manager-downloads/plugin/${SSM_PLUGIN_VERSION}/${build.path}`,
	);
	if (!response.ok)
		throw new Error(
			`Could not download AWS's session-manager-plugin (HTTP ${response.status}).`,
		);
	const zip = Buffer.from(await response.arrayBuffer());
	const sha256 = createHash("sha256").update(zip).digest("hex");
	if (sha256 !== build.sha256)
		throw new Error(
			"The downloaded session-manager-plugin does not match AWS's published build. Not running it.",
		);

	const staging = `${dir}.part`;
	await fsp.rm(staging, { recursive: true, force: true });
	await fsp.mkdir(staging, { recursive: true });
	const zipPath = path.join(staging, "plugin.zip");
	await fsp.writeFile(zipPath, zip);
	await unzip(zipPath, staging, platform);
	// Windows ships the plugin as a zip inside the zip.
	const inner = path.join(staging, "package.zip");
	if (fs.existsSync(inner))
		await unzip(inner, path.join(staging, "package"), platform);
	await fsp.rm(dir, { recursive: true, force: true });
	await fsp.rename(staging, dir);
	if (platform !== "win32") await fsp.chmod(binary, 0o755);
	return binary;
}

// macOS has unzip, and Windows 10+ has tar, which reads zip: no dependency for one archive.
async function unzip(
	zip: string,
	dest: string,
	platform: string,
): Promise<void> {
	await fsp.mkdir(dest, { recursive: true });
	if (platform === "win32") await run("tar", ["-xf", zip, "-C", dest]);
	else await run("unzip", ["-o", "-q", zip, "-d", dest]);
}

/**
 * Lets `publicKey` log in as `osUser` for the next minutes - long enough for
 * one SSH handshake. EC2 Instance Connect first (Ubuntu and Amazon Linux
 * images have it). A sign-in AWS doesn't allow that for (its own IAM action,
 * which `ec2:*` doesn't cover) gets the key through SSM Run Command instead,
 * which `ssm:*` does - so nobody needs a new permission to use a host.
 * `overSsm` goes straight to SSM, for a host that refused the Instance
 * Connect key (keyRefused).
 */
export async function pushOneTimeKey(
	target: SsmTarget,
	osUser: string,
	publicKey: string,
	{ overSsm = false }: { overSsm?: boolean } = {},
): Promise<void> {
	if (overSsm) return pushKeyOverSsm(target, osUser, publicKey);
	const client = new EC2InstanceConnectClient(awsClientConfig(target));
	const result = await client
		.send(
			new SendSSHPublicKeyCommand({
				InstanceId: target.instanceId,
				InstanceOSUser: osUser,
				SSHPublicKey: publicKey,
			}),
		)
		.catch((error: unknown) => {
			if ((error as { name?: string })?.name === "AccessDeniedException")
				return null;
			throw error;
		});
	if (!result) return pushKeyOverSsm(target, osUser, publicKey);
	if (!result.Success)
		throw new Error(
			`AWS did not accept the login key for ${target.instanceId}.`,
		);
}

/**
 * ssh2's error when the host took none of the keys offered. An Instance
 * Connect key that ran out (it lasts 60s) or that the host could not look up
 * reads like this; the key written over SSM lasts longer and needs no lookup.
 */
export const keyRefused = (err: unknown) =>
	/All configured authentication methods failed/i.test(String(err));

/**
 * The host has no Linux user by that name - the SSM key script fails with
 * this. Retrying cannot help; setting the user up does (setUpHost).
 */
export const userMissing = (err: unknown) =>
	/no such user|invalid user/i.test(String(err));

/**
 * AWS refused the call by IAM policy - a role that may not push a key to the
 * host or run commands on it. Retrying cannot help; an administrator can.
 */
export const accessDenied = (err: unknown) =>
	/AccessDenied|is not authorized to perform/i.test(
		`${(err as { name?: string } | null)?.name ?? ""} ${String(err)}`,
	);

/** The key's line lasts this long: one handshake, with room for a slow SSM. */
const KEY_LIFETIME_MS = 3 * 60_000;

/**
 * A root script that puts `publicKey` in `osUser`'s authorized_keys until
 * `expires`, marked `odin-once`, and drops odin-once lines already expired -
 * so keys never pile up, and none outlives its handshake by more than a few
 * minutes (sshd's expiry-time).
 */
export function oneTimeKeyScript(
	osUser: string,
	publicKey: string,
	expires: Date,
): string {
	if (!/^[a-z_][a-z0-9_-]*$/.test(osUser))
		throw new Error(`Not a login name: ${osUser}`);
	const key = publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
	if (!/^ssh-[a-z0-9-]+ [A-Za-z0-9+/=]+$/.test(key))
		throw new Error("Not an SSH public key.");
	const stamp = expires.toISOString().replace(/[-:T]/g, "").slice(0, 12);
	return [
		"set -e",
		`u=${osUser}`,
		'h=$(getent passwd "$u" | cut -d: -f6)',
		'f="$h/.ssh/authorized_keys"',
		'install -d -m 700 -o "$u" -g "$(id -gn "$u")" "$h/.ssh"',
		'touch "$f"',
		"now=$(date -u +%Y%m%d%H%M)",
		`awk -v now="$now" '!/ odin-once$/ || (match($0, /expiry-time="[0-9]+/) && substr($0, RSTART + 13, 12) > now)' "$f" > "$f.odin"`,
		`echo 'expiry-time="${stamp}Z" ${key} odin-once' >> "$f.odin"`,
		'chown "$u":"$(id -gn "$u")" "$f.odin"',
		'chmod 600 "$f.odin"',
		'mv "$f.odin" "$f"',
	].join("\n");
}

async function pushKeyOverSsm(
	target: SsmTarget,
	osUser: string,
	publicKey: string,
): Promise<void> {
	const ssm = new SSMClient(awsClientConfig(target));
	const script = oneTimeKeyScript(
		osUser,
		publicKey,
		new Date(Date.now() + KEY_LIFETIME_MS),
	);
	const sent = await ssm.send(
		new SendCommandCommand({
			InstanceIds: [target.instanceId],
			DocumentName: "AWS-RunShellScript",
			Comment: "Odin: one-time login key",
			TimeoutSeconds: 60,
			Parameters: { commands: [script] },
		}),
	);
	const commandId = sent.Command?.CommandId;
	if (!commandId)
		throw new Error(`SSM did not take the login key for ${target.instanceId}.`);
	for (let attempt = 0; attempt < 60; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		const result = await ssm
			.send(
				new GetCommandInvocationCommand({
					CommandId: commandId,
					InstanceId: target.instanceId,
				}),
			)
			.catch(() => null);
		const status = result?.Status ?? "Pending";
		if (["Pending", "InProgress", "Delayed"].includes(status)) continue;
		if (status === "Success") return;
		throw new Error(
			`The login key did not reach ${target.instanceId} (${status}): ${(result?.StandardErrorContent ?? "").slice(-200)}`,
		);
	}
	throw new Error(`The login key took too long to reach ${target.instanceId}.`);
}

/** What the plugin is started with - the same arguments the aws CLI gives it. */
export function pluginArgs(
	session: { SessionId?: string; TokenValue?: string; StreamUrl?: string },
	request: object,
	region: string,
	profile: string,
): string[] {
	return [
		JSON.stringify(session),
		region,
		"StartSession",
		profile,
		JSON.stringify(request),
		`https://ssm.${region}.amazonaws.com`,
	];
}

/** A stream to the instance's port 22 through SSM, for ssh2's `sock`. */
export async function openSsmStream(target: SsmTarget): Promise<Duplex> {
	const plugin = await ensureSsmPlugin();
	const ssm = new SSMClient(awsClientConfig(target));
	const region = await ssm.config.region();
	const request = {
		Target: target.instanceId,
		DocumentName: "AWS-StartSSHSession",
		Parameters: { portNumber: ["22"] },
	};
	const session = await ssm.send(new StartSessionCommand(request));
	const child = spawn(
		plugin,
		pluginArgs(
			{
				SessionId: session.SessionId,
				TokenValue: session.TokenValue,
				StreamUrl: session.StreamUrl,
			},
			request,
			region,
			target.profile ?? "",
		),
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-2_000);
	});
	const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
	// destroy() on this stream emits an AbortError. Before ssh2 attaches its
	// own listener (a login key that failed to push), nothing heard it and
	// the helper crashed with "Unhandled 'error' event".
	stream.on("error", () => {});
	child.on("exit", (code) => {
		if (!stream.destroyed)
			stream.destroy(
				code
					? new Error(`SSM session ended: ${stderr.trim() || `exit ${code}`}`)
					: undefined,
			);
	});
	child.on("error", (error) => stream.destroy(error));
	stream.on("close", () => {
		if (child.exitCode === null) child.kill();
		// The aws CLI ends the session itself after the plugin exits; killing
		// the plugin doesn't. Without this every failed connect leaves a
		// session, and a worker process on the host, until AWS times it out.
		ssm
			.send(new TerminateSessionCommand({ SessionId: session.SessionId }))
			.catch(() => {});
	});
	return stream;
}
