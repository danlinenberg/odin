import { expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { providerToken, pushRoute, type Transport } from "./push";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const config = {
	keyId: "ABC123DEFG",
	teamId: "TEAM123456",
	topic: "com.example.odin",
	key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const token = "ab".repeat(32);
const post = (body: object) =>
	new Request("http://relay/push", {
		method: "POST",
		body: JSON.stringify(body),
	});

test("the provider token is ES256, signed by the key, issued by the team", () => {
	const [head, claims, signature] = providerToken(config).jwt.split(".");
	expect(JSON.parse(Buffer.from(head, "base64url").toString()).kid).toBe(
		"ABC123DEFG",
	);
	expect(JSON.parse(Buffer.from(claims, "base64url").toString()).iss).toBe(
		"TEAM123456",
	);
	expect(
		verify(
			"sha256",
			Buffer.from(`${head}.${claims}`),
			{ key: createPublicKey(privateKey), dsaEncoding: "ieee-p1363" },
			Buffer.from(signature, "base64url"),
		),
	).toBe(true);
});

test("a push goes to the Odin app's topic only, with just the end times", async () => {
	const asked: { host: string; headers: Record<string, string> }[] = [];
	const apple: Transport = async (host, _path, headers, body) => {
		asked.push({ host, headers });
		expect(JSON.parse(body)).toEqual({
			aps: { "content-available": 1 },
			ended: [1, 2],
		});
		// An Xcode build's token: production refuses it, the sandbox takes it.
		return host.includes("sandbox")
			? { status: 200 }
			: { status: 400, reason: "BadDeviceToken" };
	};
	const push = pushRoute(config, apple);
	const answer = await push(
		post({ token, ended: [1, 2], topic: "com.other.app" }),
		"1.2.3.4",
	);
	expect(await answer.json()).toEqual({ sent: "sandbox" });
	expect(asked.map((a) => a.headers["apns-topic"])).toEqual([
		"com.example.odin",
		"com.example.odin",
	]);
	// The same phone again at once: held back.
	expect((await push(post({ token, ended: [] }), "1.2.3.4")).status).toBe(429);
});

test("bad input, a deleted app, and a relay without the key", async () => {
	const gone = pushRoute(config, async () => ({ status: 410 }));
	expect((await gone(post({ token: "zz", ended: [] }), "ip")).status).toBe(400);
	expect(
		(await gone(post({ token, ended: Array(51).fill(1) }), "ip")).status,
	).toBe(400);
	expect((await gone(post({ token, ended: [] }), "ip")).status).toBe(410);
	expect((await pushRoute(null)(post({ token, ended: [] }), "ip")).status).toBe(
		503,
	);
});
