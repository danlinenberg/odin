import log from "electron-log/main";
import { startRemoteAgentEventsBridge } from "./agent-events-bridge";
import { getActiveConnectionRow, toConfig } from "./config";
import { getRemoteConnectionManager } from "./remote-connection-manager";

/**
 * At app start: follow remote agent events, and if the user was running on a
 * server when the app last quit (or the laptop rebooted), go straight back to
 * remote mode and reconnect in the background. Sessions kept running there.
 */
export function startRemoteSessions(): void {
	startRemoteAgentEventsBridge();
	try {
		const row = getActiveConnectionRow();
		if (!row) return;
		log.info(`[remote-connection] resuming remote mode on ${row.host}`);
		getRemoteConnectionManager().resume(toConfig(row));
	} catch (error) {
		log.warn(`[remote-connection] could not resume remote mode: ${error}`);
	}
}
