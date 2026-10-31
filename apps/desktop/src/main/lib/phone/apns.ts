import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:http2";
import { join } from "node:path";
import { ODIN_HOME_DIR } from "../app-environment";

/**
 * Silent pushes to the iPhone app, straight from Odin to Apple (no server of
 * ours in between), so the lock screen widget's count moves with the phone
 * locked. Signed with the user's own APNs key from their Apple developer
 * account (Settings > Remote > Phone), kept here, mode 0600.
 */

export type PushKey = { keyId: string; teamId: string; key: string };

/** Where a phone's pushes go: its token, its app's bundle ID, and which APNs. */
export type PushTarget = { token: string; topic: string; sandbox?: boolean };

export const pushKeyFile = { path: join(ODIN_HOME_DIR, "phone-push.json") };

export function readPushKey(): PushKey | null {
	try {
		const saved = JSON.parse(readFileSync(pushKeyFile.path, "utf8"));
		return saved?.keyId && saved.teamId && saved.key ? saved : null;
	} catch {
		return null;
	}
}

const TEN_CHARS = /^[A-Z0-9]{10}$/;

/** Checks the key signs before it's saved: a wrong file fails here, not at the first push. */
export function savePushKey(input: PushKey): void {
	const keyId = input.keyId.trim().toUpperCase();
	const teamId = input.teamId.trim().toUpperCase();
	if (!TEN_CHARS.test(keyId))
		throw new Error("The Key ID is 10 letters and digits.");
	if (!TEN_CHARS.test(teamId))
		throw new Error("The Team ID is 10 letters and digits.");
	try {
		apnsJwt({ keyId, teamId, key: input.key });
	} catch {
		throw new Error("That file isn't an APNs key (.p8).");
	}
	writeFileSync(
		pushKeyFile.path,
		JSON.stringify({ keyId, teamId, key: input.key }),
		{ mode: 0o600 },
	);
	cached = null;
}

export const clearPushKey = () => {
	try {
		unlinkSync(pushKeyFile.path);
	} catch {}
	cached = null;
};

const b64url = (data: string | Buffer) =>
	Buffer.from(data).toString("base64url");

let cached: { kid: string; at: number; jwt: string } | null = null;

/** APNs' provider token: ES256, good for an hour, so remade every 50 minutes. */
export function apnsJwt(key: PushKey, now = Date.now()): string {
	if (cached?.kid === key.keyId && now - cached.at < 50 * 60_000)
		return cached.jwt;
	const head = b64url(JSON.stringify({ alg: "ES256", kid: key.keyId }));
	const claims = b64url(
		JSON.stringify({ iss: key.teamId, iat: Math.floor(now / 1000) }),
	);
	const signature = sign("sha256", Buffer.from(`${head}.${claims}`), {
		key: createPrivateKey(key.key),
		dsaEncoding: "ieee-p1363",
	});
	const jwt = `${head}.${claims}.${b64url(signature)}`;
	cached = { kid: key.keyId, at: now, jwt };
	return jwt;
}

const HOSTS = {
	production: "https://api.push.apple.com",
	sandbox: "https://api.sandbox.push.apple.com",
};

type Answer = { status: number; reason?: string };

function post(
	host: string,
	target: PushTarget,
	jwt: string,
	body: string,
): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const session = connect(host);
		session.on("error", reject);
		const request = session.request({
			":method": "POST",
			":path": `/3/device/${target.token}`,
			authorization: `bearer ${jwt}`,
			"apns-push-type": "background",
			"apns-priority": "5",
			"apns-topic": target.topic,
			"content-type": "application/json",
		});
		let status = 0;
		let text = "";
		request.on("response", (headers) => {
			status = Number(headers[":status"]);
		});
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			text += chunk;
		});
		request.on("end", () => {
			session.close();
			let reason: string | undefined;
			try {
				reason = JSON.parse(text).reason;
			} catch {}
			resolve({ status, reason });
		});
		request.on("error", (error) => {
			session.close();
			reject(error);
		});
		request.setTimeout(15_000, () => request.close());
		request.end(body);
	});
}

/**
 * One silent push. `sent` names the APNs that took it - an Xcode build's
 * token is the sandbox's, a TestFlight build's production's, and the phone
 * can't tell which it is, so an unknown one tries both. `gone`: the app was
 * deleted, drop the token.
 */
export async function sendPush(
	target: PushTarget,
	payload: object,
	key: PushKey,
	transport = post,
): Promise<{ sent: "production" | "sandbox" } | { gone: true } | null> {
	const jwt = apnsJwt(key);
	const body = JSON.stringify({ aps: { "content-available": 1 }, ...payload });
	const order: ("production" | "sandbox")[] =
		target.sandbox === true
			? ["sandbox"]
			: target.sandbox === false
				? ["production"]
				: ["production", "sandbox"];
	for (const env of order) {
		const answer = await transport(HOSTS[env], target, jwt, body);
		if (answer.status === 200) return { sent: env };
		if (answer.status === 410) return { gone: true };
		if (answer.reason !== "BadDeviceToken")
			console.warn(
				`[phone-push] APNs ${env} answered ${answer.status} ${answer.reason ?? ""}`,
			);
	}
	return null;
}
