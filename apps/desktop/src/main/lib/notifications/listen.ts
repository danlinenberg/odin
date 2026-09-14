import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { env } from "shared/env.shared";
import { ODIN_HOME_DIR } from "../app-environment";

/**
 * The port the hook server actually bound.
 *
 * Agents notify the app over HTTP: `notify.sh` POSTs to `$ODIN_PORT`, which
 * the terminal env exports from here. Odin inherits its upstream's
 * default port, so when both apps run at once the second one loses the bind —
 * and every agent event (Start/Stop/PermissionRequest) goes to the app that
 * doesn't own the session. Symptom: a session that keeps working while the
 * board still shows it as needing input, because no event ever arrives to
 * clear the status.
 *
 * So the loser takes a free port instead of going deaf, and the terminal env
 * hands its sessions the port that actually answers.
 */
let boundPort: number = env.DESKTOP_NOTIFICATIONS_PORT;

export function getNotificationsPort(): number {
	return boundPort;
}

/**
 * Where notify.sh looks the port up at call time. $ODIN_PORT is baked into
 * a session's env at launch and goes stale the moment the app restarts onto a
 * different fallback port — the session keeps running, every hook POSTs into
 * the void, and its board card freezes (the bug this file's header describes,
 * one restart later). The file is per-app (ODIN_HOME_DIR), so two
 * Odin-family apps still route to their own sessions.
 */
export const PORT_FILE = path.join(ODIN_HOME_DIR, "notifications-port");

function writePortFile(port: number): void {
	try {
		fs.mkdirSync(ODIN_HOME_DIR, { recursive: true });
		fs.writeFileSync(PORT_FILE, String(port));
	} catch (error) {
		// Best effort — $ODIN_PORT still covers the no-restart case.
		console.error("[notifications] Could not write port file:", error);
	}
}

/**
 * Bind the hook server, falling back to an ephemeral port when the preferred
 * one is taken. Returns a handle whose `close()` targets the live server, since
 * the fallback replaces it.
 *
 * The server is created here rather than via `app.listen()` so the `error`
 * listener is attached before the bind — otherwise EADDRINUSE can land before
 * anything is listening for it, and the fallback never runs.
 */
export function listenForHooks(
	requestHandler: http.RequestListener,
	preferredPort: number = env.DESKTOP_NOTIFICATIONS_PORT,
): { close: () => void } {
	let current: http.Server | null = null;

	const bind = (port: number): void => {
		const server = http.createServer(requestHandler);
		current = server;

		server.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EADDRINUSE" || port === 0) {
				console.error("[notifications] Hook server failed to bind:", error);
				return;
			}
			console.error(
				`[notifications] Port ${port} is taken — another Odin-family app owns it. Falling back to a free port so this app's agent hooks reach it.`,
			);
			bind(0);
		});

		server.listen(port, "127.0.0.1", () => {
			const address = server.address() as AddressInfo | string | null;
			boundPort =
				address && typeof address === "object" ? address.port : preferredPort;
			writePortFile(boundPort);
			console.log(
				`[notifications] Listening on http://127.0.0.1:${boundPort}${
					boundPort === preferredPort ? "" : " (preferred port was taken)"
				}`,
			);
		});
	};

	bind(preferredPort);
	return { close: () => current?.close() };
}
