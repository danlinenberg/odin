import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ODIN_HOME_DIR } from "../app-environment";

/**
 * The remote host's phone server, as a phone paired with this computer
 * reaches it: the host's key, relay and name in a link with no code
 * (main/lib/phone/host/server.ts, `hostLink`). Odin reads it from the host at
 * each sync and hands it to its phones, so one QR code covers both. Each
 * profile has its own user on the host, so its own server and link: kept per
 * profile, for the phone to switch between them with this computer away.
 * Each host in the cluster runs its own server too, so a profile keeps one
 * link per host: the phone asks them all for their sessions.
 */

/** Where it is kept; a test points it at a temp file. */
export const hostLinkFile = {
	path: join(ODIN_HOME_DIR, "phone-host-link.json"),
};

type Saved = { instanceId: string; link: string };
/**
 * The last link read, as older Odins kept it, each profile's last, and each
 * profile's link per host (instance id).
 */
type SavedFile = Partial<Saved> & {
	profiles?: Record<string, Saved>;
	hosts?: Record<string, Record<string, string>>;
};

function readSaved(): SavedFile {
	try {
		const saved = JSON.parse(readFileSync(hostLinkFile.path, "utf8"));
		return saved && typeof saved === "object" ? saved : {};
	} catch {
		return {};
	}
}

export function saveHostLink(
	instanceId: string,
	link: string,
	profileId: string,
): void {
	const file = readSaved();
	const saved: SavedFile = {
		instanceId,
		link,
		profiles: { ...file.profiles, [profileId]: { instanceId, link } },
		hosts: {
			...file.hosts,
			[profileId]: { ...file.hosts?.[profileId], [instanceId]: link },
		},
	};
	writeFileSync(hostLinkFile.path, JSON.stringify(saved), { mode: 0o600 });
}

/**
 * The link for this profile's host, or null when Odin hasn't read one from
 * it yet. A file from before links were kept per profile has one link: it
 * stands for any profile on that host until the next sync.
 */
export function hostLinkFor(
	instanceId: string | undefined,
	profileId: string,
): string | null {
	if (!instanceId) return null;
	const file = readSaved();
	const own = file.hosts?.[profileId]?.[instanceId];
	if (own?.startsWith("odin://pair?")) return own;
	const saved = file.profiles ? file.profiles[profileId] : file;
	return saved?.instanceId === instanceId &&
		typeof saved.link === "string" &&
		saved.link.startsWith("odin://pair?")
		? saved.link
		: null;
}

/** The links for these hosts (a cluster's), skipping ones Odin hasn't read yet. */
export function hostLinksFor(
	instanceIds: (string | undefined)[],
	profileId: string,
): string[] {
	return instanceIds.flatMap((id) => {
		const link = hostLinkFor(id, profileId);
		return link ? [link] : [];
	});
}
