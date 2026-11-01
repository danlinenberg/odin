import { createPrivateKey, sign } from "node:crypto";
import { connect } from "node:http2";

/**
 * The lock screen widget's silent pushes (apps/mobile/ios/App/OdinWidget),
 * signed here with the App Store app's APNs key, so no Odin user needs one:
 *
 *   POST /push   {token, ended: [ms, ...], sandbox?}
 *
 * Odin on the user's computer sends it when the sessions that ended in the
 * last hour change (apps/desktop/src/main/lib/phone/push.ts). The push holds
 * only those end times. The relay keeps nothing: no token is stored, and the
 * topic is fixed to the Odin app, so it can't push to any other app.
 */

export type PushConfig = {
	/** The .p8 key's PEM text. */
	key: string;
	keyId: string;
	teamId: string;
	/** The app's bundle ID. */
	topic: string;
};

type Env = "production" | "sandbox";
type Answer = { status: number; reason?: string };
export type Transport = (
	host: string,
	path: string,
	headers: Record<string, string>,
	body: string,
) => Promise<Answer>;

const HOSTS: Record<Env, string> = {
	production: "https://api.push.apple.com",
	sandbox: "https://api.sandbox.push.apple.com",
};

const TOKEN = /^[0-9a-f]{64,200}$/;
const MAX_BODY = 4_096;
const MAX_ENDED = 50;
/** One push per phone per this long: iOS drops silent pushes that come faster anyway. */
const TOKEN_GAP_MS = 20_000;
/** Pushes one IP address may ask for in a minute: one Odin with a few phones needs a handful. */
const PER_IP_MINUTE = 60;

const b64url = (data: string | Buffer) =>
	Buffer.from(data).toString("base64url");

/** APNs' provider token: ES256, good for an hour, remade every 50 minutes. */
export function providerToken(
	config: PushConfig,
	now = Date.now(),
	cache: { at: number; jwt: string } | null = null,
): { at: number; jwt: string } {
	if (cache && now - cache.at < 50 * 60_000) return cache;
	const head = b64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
	const claims = b64url(
		JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }),
	);
	const signature = sign("sha256", Buffer.from(`${head}.${claims}`), {
		key: createPrivateKey(config.key),
		dsaEncoding: "ieee-p1363",
	});
	return { at: now, jwt: `${head}.${claims}.${b64url(signature)}` };
}

const http2Post: Transport = (host, path, headers, body) =>
	new Promise((resolve, reject) => {
		const session = connect(host);
		session.on("error", reject);
		const request = session.request({
			":method": "POST",
			":path": path,
			...headers,
		});
		let status = 0;
		let text = "";
		request.on("response", (h) => {
			status = Number(h[":status"]);
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

const json = (status: number, value?: object) =>
	value ? Response.json(value, { status }) : new Response(null, { status });

/** The /push route; null config answers 503 (a relay run without the key). */
export function pushRoute(
	config: PushConfig | null,
	transport: Transport = http2Post,
) {
	let cache: { at: number; jwt: string } | null = null;
	const lastByToken = new Map<string, number>();
	const byIp = new Map<string, { start: number; count: number }>();

	return async (req: Request, ip: string): Promise<Response> => {
		if (req.method !== "POST") return json(405);
		if (!config) return json(503);
		const now = Date.now();
		const window = byIp.get(ip);
		if (!window || now - window.start > 60_000) {
			if (byIp.size > 10_000) byIp.clear();
			byIp.set(ip, { start: now, count: 1 });
		} else if (++window.count > PER_IP_MINUTE) return json(429);
		const text = await req.text();
		if (text.length > MAX_BODY) return json(413);
		let input: { token?: unknown; ended?: unknown; sandbox?: unknown };
		try {
			input = JSON.parse(text);
		} catch {
			return json(400);
		}
		const { token, ended, sandbox } = input;
		if (typeof token !== "string" || !TOKEN.test(token)) return json(400);
		if (
			!Array.isArray(ended) ||
			ended.length > MAX_ENDED ||
			!ended.every((at) => Number.isFinite(at))
		)
			return json(400);

		if (now - (lastByToken.get(token) ?? 0) < TOKEN_GAP_MS) return json(429);
		lastByToken.set(token, now);
		if (lastByToken.size > 10_000)
			for (const [key, at] of lastByToken)
				if (now - at > TOKEN_GAP_MS) lastByToken.delete(key);

		cache = providerToken(config, now, cache);
		const headers = {
			authorization: `bearer ${cache.jwt}`,
			"apns-push-type": "background",
			"apns-priority": "5",
			"apns-topic": config.topic,
			"content-type": "application/json",
		};
		const body = JSON.stringify({ aps: { "content-available": 1 }, ended });
		// An Xcode build's token is the sandbox's, an App Store build's
		// production's; Odin says which once it knows.
		const order: Env[] =
			sandbox === true
				? ["sandbox"]
				: sandbox === false
					? ["production"]
					: ["production", "sandbox"];
		for (const env of order) {
			const answer = await transport(
				HOSTS[env],
				`/3/device/${token}`,
				headers,
				body,
			).catch(() => ({ status: 502 }) as Answer);
			if (answer.status === 200) return json(200, { sent: env });
			if (answer.status === 410) return json(410);
			if (answer.reason !== "BadDeviceToken")
				console.warn(
					`[push] APNs ${env}: ${answer.status} ${answer.reason ?? ""}`,
				);
		}
		return json(502);
	};
}
