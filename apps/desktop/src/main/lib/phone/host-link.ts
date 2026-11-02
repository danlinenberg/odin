import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ODIN_HOME_DIR } from "../app-environment";

/**
 * The remote host's phone server, as a phone paired with this computer
 * reaches it: the host's key, relay and name in a link with no code
 * (main/lib/phone/host/server.ts, `hostLink`). Odin reads it from the host at
 * each sync and hands it to its phones, so one QR code covers both.
 */

/** Where it is kept; a test points it at a temp file. */
export const hostLinkFile = {
	path: join(ODIN_HOME_DIR, "phone-host-link.json"),
};

type Saved = { instanceId: string; link: string };

export function saveHostLink(instanceId: string, link: string): void {
	const saved: Saved = { instanceId, link };
	writeFileSync(hostLinkFile.path, JSON.stringify(saved), { mode: 0o600 });
}

/** The link for this host, or null when Odin hasn't read one from it yet. */
export function hostLinkFor(instanceId: string | undefined): string | null {
	if (!instanceId) return null;
	try {
		const saved = JSON.parse(
			readFileSync(hostLinkFile.path, "utf8"),
		) as Partial<Saved>;
		return saved.instanceId === instanceId &&
			typeof saved.link === "string" &&
			saved.link.startsWith("odin://pair?")
			? saved.link
			: null;
	} catch {
		return null;
	}
}
