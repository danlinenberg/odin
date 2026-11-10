import { statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ODIN_HOME_DIR } from "../app-environment";

/**
 * A file each host's panes share: touched when one of them gets into the
 * host, or once a reboot from the board has had time to boot. The others,
 * waiting out a retry (up to 30 minutes once stopped), try again at once:
 * after a host came back, a dozen panes each sat on its own timer.
 */
const upFile = (instanceId: string) =>
	join(ODIN_HOME_DIR, "remote-hosts", `${instanceId}.up`);

export async function markHostUp(instanceId: string): Promise<void> {
	const file = upFile(instanceId);
	await mkdir(join(file, ".."), { recursive: true }).catch(() => {});
	await writeFile(file, String(Date.now())).catch(() => {});
}

/** Whether a pane got into the host (or the board rebooted it) after `since`. */
export function hostUpSince(instanceId: string, since: number): boolean {
	try {
		return statSync(upFile(instanceId)).mtimeMs > since;
	} catch {
		return false;
	}
}
