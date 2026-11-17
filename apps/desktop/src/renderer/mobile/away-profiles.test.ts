import { expect, test } from "bun:test";
import {
	awayClusterLinks,
	awayLink,
	awayLinkOf,
	awayProfileId,
	forgetAwayLink,
	HOST_PAIRING_KEY,
	pickAwayProfile,
	rememberProfiles,
} from "./away-profiles";

function store() {
	const map = new Map<string, string>();
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
		removeItem: (key: string) => void map.delete(key),
	};
}

const mac = {
	activeId: "work",
	profiles: [
		{ id: "work", name: "Work", hostLink: "odin://pair?k=work" },
		{ id: "personal", name: "Personal", hostLink: "odin://pair?k=personal" },
		{ id: "side", name: "Side", hostLink: null },
	],
};

test("with the Mac away the phone asks the Mac's last profile, then the one picked", () => {
	const s = store();
	rememberProfiles(s, mac);
	expect(awayProfileId(s)).toBe("work");
	expect(awayLink(s)).toBe("odin://pair?k=work");
	pickAwayProfile(s, "personal");
	expect(awayLink(s)).toBe("odin://pair?k=personal");
	// A profile with nothing on a host needs the Mac.
	expect(awayLinkOf(s, "side")).toBeNull();
	// The Mac is back: its profile stands again.
	rememberProfiles(s, mac);
	expect(awayProfileId(s)).toBe("work");
});

test("a Mac that sent no link per profile: its own profile keeps the one link", () => {
	const s = store();
	s.setItem(HOST_PAIRING_KEY, "odin://pair?k=old");
	expect(awayLink(s)).toBe("odin://pair?k=old");
	rememberProfiles(s, {
		activeId: "work",
		profiles: [
			{ id: "work", name: "Work" },
			{ id: "personal", name: "Personal" },
		],
	});
	expect(awayLinkOf(s, "work")).toBe("odin://pair?k=old");
	expect(awayLinkOf(s, "personal")).toBeNull();
});

test("a host that refused the phone: its link goes, the other profiles' stay", () => {
	const s = store();
	s.setItem(HOST_PAIRING_KEY, "odin://pair?k=work");
	rememberProfiles(s, mac);
	pickAwayProfile(s, "personal");
	forgetAwayLink(s);
	expect(awayLinkOf(s, "personal")).toBeNull();
	expect(awayProfileId(s)).toBe("work");
	expect(awayLink(s)).toBe("odin://pair?k=work");
});

test("the away profile's cluster hosts are asked beside its link", () => {
	const s = store();
	rememberProfiles(s, {
		activeId: "work",
		profiles: [
			{
				id: "work",
				name: "Work",
				hostLink: "odin://pair?k=work",
				clusterLinks: ["odin://pair?k=two"],
			},
			{ id: "side", name: "Side", hostLink: null, clusterLinks: ["x"] },
		],
	});
	expect(awayClusterLinks(s)).toEqual(["odin://pair?k=two"]);
	// No main host link: nothing on a host, cluster or not.
	pickAwayProfile(s, "side");
	expect(awayClusterLinks(s)).toEqual([]);
});
