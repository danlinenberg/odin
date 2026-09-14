import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

// Before the import: PORT_FILE is resolved at module load, and without this the
// suite would overwrite the running app's real port file with a dead port.
process.env.ODIN_HOME_DIR = fs.mkdtempSync(
	path.join(os.tmpdir(), "odin-test-"),
);
const { getNotificationsPort, listenForHooks, PORT_FILE } = await import(
	"./listen"
);

function occupy(): Promise<http.Server> {
	return new Promise((resolve) => {
		const server = http.createServer();
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

function portOf(server: http.Server): number {
	return (server.address() as AddressInfo).port;
}

describe("listenForHooks", () => {
	it("falls back to a free port when the preferred one is taken", async () => {
		// Stand in for the other Odin-family app holding the default port.
		const squatter = await occupy();
		const taken = portOf(squatter);

		// boundPort starts at the configured default, never at `taken`, so wait
		// for it to move off whatever it was before this bind.
		const before = getNotificationsPort();
		const handle = listenForHooks((_req, res) => res.end("ok"), taken);
		try {
			for (let i = 0; i < 40 && getNotificationsPort() === before; i++) {
				await Bun.sleep(25);
			}
			const port = getNotificationsPort();
			expect(port).not.toBe(taken);

			// The reported port is the one that actually answers — that's the whole
			// point: agents read it from ODIN_PORT.
			const response = await fetch(`http://127.0.0.1:${port}/`);
			expect(response.status).toBe(200);

			// …and notify.sh reads it from the port file, which survives the
			// session's baked-in $ODIN_PORT going stale across a restart.
			expect(fs.readFileSync(PORT_FILE, "utf-8")).toBe(String(port));
		} finally {
			handle.close();
			squatter.close();
		}
	});
});
