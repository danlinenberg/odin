import { expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { apnsJwt, sendPush } from "./apns";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const key = {
	keyId: "ABC123DEFG",
	teamId: "TEAM123456",
	key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

test("the provider token is ES256, signed by the key, issued by the team", () => {
	const [head, claims, signature] = apnsJwt(key, 1_000_000).split(".");
	expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({
		alg: "ES256",
		kid: "ABC123DEFG",
	});
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

test("an Xcode build's token: production says BadDeviceToken, the sandbox takes it", async () => {
	const asked: string[] = [];
	const result = await sendPush(
		{ token: "ab".repeat(32), topic: "com.example.odin" },
		{ ended: [1] },
		key,
		async (host, _target, _jwt, body) => {
			asked.push(host);
			expect(JSON.parse(body)).toEqual({
				aps: { "content-available": 1 },
				ended: [1],
			});
			return host.includes("sandbox")
				? { status: 200 }
				: { status: 400, reason: "BadDeviceToken" };
		},
	);
	expect(result).toEqual({ sent: "sandbox" });
	expect(asked).toHaveLength(2);
});

test("a deleted app's token is gone", async () => {
	const result = await sendPush(
		{ token: "ab".repeat(32), topic: "com.example.odin", sandbox: false },
		{ ended: [] },
		key,
		async () => ({ status: 410, reason: "Unregistered" }),
	);
	expect(result).toEqual({ gone: true });
});
