import { startRelay } from "./relay";

/**
 * Run a relay: `bun src/main.ts`, or the Docker image (see README.md).
 * PORT (default 8443), HOSTNAME, and TLS_CERT + TLS_KEY (PEM file paths) for
 * wss:// directly - or leave TLS to a proxy in front, with TRUST_PROXY=1 so
 * the per-IP limit counts clients, not the proxy.
 */
const port = Bun.env.PORT;
const certFile = Bun.env.TLS_CERT;
const keyFile = Bun.env.TLS_KEY;
const server = startRelay({
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
console.log(`Odin relay on ${server.url}`);
