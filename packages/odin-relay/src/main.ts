import { startRelay } from "./relay";

/**
 * Run a relay: `bun src/main.ts`, or the Docker image (see README.md).
 * PORT (default 8443), HOSTNAME, and TLS_CERT + TLS_KEY (PEM file paths) for
 * wss:// directly - or leave TLS to a proxy in front, with TRUST_PROXY=1 so
 * the per-IP limit counts clients, not the proxy.
 *
 * The lock screen widget's pushes (push.ts): APNS_KEY_FILE (the .p8),
 * APNS_KEY_ID, APNS_TEAM_ID and APNS_TOPIC (the app's bundle ID). Without
 * them the relay runs as before and /push answers 503.
 */
const port = Bun.env.PORT;
const certFile = Bun.env.TLS_CERT;
const keyFile = Bun.env.TLS_KEY;
const apnsKeyFile = Bun.env.APNS_KEY_FILE;
const push =
	apnsKeyFile && Bun.env.APNS_KEY_ID && Bun.env.APNS_TEAM_ID
		? {
				key: await Bun.file(apnsKeyFile).text(),
				keyId: Bun.env.APNS_KEY_ID,
				teamId: Bun.env.APNS_TEAM_ID,
				topic: Bun.env.APNS_TOPIC ?? "com.danlinenberg.odin",
			}
		: null;
const server = startRelay({
	push,
	port: port ? Number(port) : undefined,
	hostname: Bun.env.HOSTNAME,
	trustProxy: Bun.env.TRUST_PROXY === "1",
	tls:
		certFile && keyFile
			? {
					cert: await Bun.file(certFile).text(),
					key: await Bun.file(keyFile).text(),
				}
			: undefined,
});
console.log(
	`Odin relay on ${server.url}${push ? `, pushes for ${push.topic}` : ""}`,
);
