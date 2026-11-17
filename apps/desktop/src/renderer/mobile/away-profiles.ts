/**
 * Odin's profiles as the Mac last listed them, kept on this phone for when
 * the Mac is away: the remote host knows no profiles. Each profile has its
 * own user on the host, with its own phone server and link (`hostLink`), so
 * the phone switches profile there by asking another link. A profile with no
 * link has nothing on a host: it needs the Mac.
 */
export type PhoneProfile = {
	id: string;
	name: string;
	hostLink?: string | null;
	/** The profile's other hosts in the cluster: the phone asks them beside it. */
	clusterLinks?: string[];
};
export type KnownProfiles = { activeId: string; profiles: PhoneProfile[] };

const PROFILES_KEY = "odin-phone-profiles";
/** The profile picked with the Mac away; the Mac's own once it answers again. */
const AWAY_PROFILE_KEY = "odin-phone-away-profile";
/** The remote host's link for the profile the Mac is in (main.tsx). */
export const HOST_PAIRING_KEY = "odin-phone-host-pairing";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function knownProfiles(store: Store): KnownProfiles {
	try {
		const saved = JSON.parse(store.getItem(PROFILES_KEY) ?? "");
		if (typeof saved.activeId === "string" && Array.isArray(saved.profiles))
			return saved;
	} catch {}
	return { activeId: "", profiles: [] };
}

/** The Mac answered with its profiles: kept, and the phone follows the Mac's again. */
export function rememberProfiles(store: Store, answer: KnownProfiles): void {
	store.setItem(
		PROFILES_KEY,
		JSON.stringify({
			activeId: answer.activeId,
			profiles: answer.profiles.map(({ id, name, hostLink, clusterLinks }) => ({
				id,
				name,
				hostLink: hostLink ?? null,
				clusterLinks: clusterLinks ?? [],
			})),
		}),
	);
	store.removeItem(AWAY_PROFILE_KEY);
}

/** The profile shown with the Mac away: the one picked, else the Mac's last. */
export const awayProfileId = (store: Store): string =>
	store.getItem(AWAY_PROFILE_KEY) ?? knownProfiles(store).activeId;

export const pickAwayProfile = (store: Store, id: string): void =>
	store.setItem(AWAY_PROFILE_KEY, id);

/**
 * The link that reaches a profile's sessions with the Mac away, or null: it
 * needs the Mac. The Mac's own profile also has the link the Mac sent by
 * itself, from before it sent one with each profile.
 */
export function awayLinkOf(store: Store, id: string): string | null {
	const known = knownProfiles(store);
	return (
		known.profiles.find((profile) => profile.id === id)?.hostLink ??
		(id === known.activeId || !known.profiles.length
			? store.getItem(HOST_PAIRING_KEY)
			: null)
	);
}

/** The remote host's link to ask right now, with the Mac away. */
export const awayLink = (store: Store): string | null =>
	awayLinkOf(store, awayProfileId(store));

/** The away profile's other cluster hosts, asked beside its link (none without one). */
export function awayClusterLinks(store: Store): string[] {
	const id = awayProfileId(store);
	if (!awayLinkOf(store, id)) return [];
	return (
		knownProfiles(store).profiles.find((profile) => profile.id === id)
			?.clusterLinks ?? []
	);
}

/** A host refused this phone: its link is forgotten; the Mac sends it again once it's back. */
export function forgetAwayLink(store: Store): void {
	const refused = awayLink(store);
	if (store.getItem(HOST_PAIRING_KEY) === refused)
		store.removeItem(HOST_PAIRING_KEY);
	const known = knownProfiles(store);
	store.setItem(
		PROFILES_KEY,
		JSON.stringify({
			...known,
			profiles: known.profiles.map((profile) =>
				profile.hostLink === refused ? { ...profile, hostLink: null } : profile,
			),
		}),
	);
	store.removeItem(AWAY_PROFILE_KEY);
}

/** Reset pairing: nothing of the Mac's profiles stays on the phone. */
export function forgetProfiles(store: Store): void {
	store.removeItem(PROFILES_KEY);
	store.removeItem(AWAY_PROFILE_KEY);
}
