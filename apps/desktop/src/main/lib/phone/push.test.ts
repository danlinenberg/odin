import { afterAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { startRelay } from "@odin/relay";
import { pushRelay, sendPush } from "./push";

// Odin's relay with a test APNs key, and Apple played by the test.
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pushed: string[] = [];
const relay = startRelay({
	port: 0,
	hostname: "127.0.0.1",
	push: {
		keyId: "ABC123DEFG",
		teamId: "TEAM123456",
		topic: "com.example.odin",
		key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	},
	pushTransport: async (host, path, _headers, body) => {
		pushed.push(`${host}${path} ${body}`);
		return { status: 200 };
	},
});
pushRelay.url = `http://127.0.0.1:${relay.port}/push`;
afterAll(() => void relay.stop(true));

test("Odin sends the end times to its relay, which pushes them with the app's key", async () => {
	const token = "ab".repeat(32);
	expect(
		await sendPush({ token, topic: "com.example.odin", sandbox: false }, [5]),
	).toEqual({ sent: "production" });
	expect(pushed).toEqual([
		`https://api.push.apple.com/3/device/${token} {"aps":{"content-available":1},"ended":[5]}`,
	]);
});
