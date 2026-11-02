import { describe, expect, it } from "bun:test";
import { ODIN_GUIDE } from "shared/odin-guide";
import {
	SCREENS,
	SETTINGS_INDEX,
} from "../settings/components/SettingsSidebar/settings-index";
import { FEED_TABS } from "./components/feed-counts";
import { MORE_ITEMS, RAIL_ITEMS, SETTINGS_ITEM } from "./components/rail-items";

/**
 * Huginn answers from the guide, so a screen, tab, connection or setting the
 * guide leaves out is one he says Odin doesn't have. These lists come from the
 * code that draws them: a new one fails here until the guide names it.
 */
const guide = ODIN_GUIDE.toLowerCase();
const section = (heading: string) => {
	const part = ODIN_GUIDE.split(/\n(?=## )/).find((s) =>
		s.startsWith(`## ${heading}`),
	);
	if (!part) throw new Error(`The guide has no "## ${heading}" section.`);
	return part.toLowerCase();
};
const missing = (names: string[], text: string) =>
	names.filter((name) => !text.includes(name.toLowerCase()));

/** A connection's name as Settings → Connections shows it. */
const connectionName = (tab: (typeof FEED_TABS)[number]) =>
	"provider" in tab && tab.provider === "gmail" ? "Gmail" : tab.label;
const connections = FEED_TABS.filter((tab) => "provider" in tab).map(
	connectionName,
);

describe("the Odin guide covers every", () => {
	it("rail entry, in Left rail", () => {
		const labels = [...RAIL_ITEMS, ...MORE_ITEMS, SETTINGS_ITEM].map(
			(item) => item.label,
		);
		expect(missing(labels, section("Left rail"))).toEqual([]);
	});

	it("Tasks tab, in the Tasks screen section", () => {
		const labels = FEED_TABS.map((tab) => tab.label);
		expect(missing(labels, section("Tasks screen"))).toEqual([]);
	});

	it("connection, in Connections and as an integration", () => {
		expect(missing(connections, section("Connections"))).toEqual([]);
		expect(section("Connections")).toContain("integrations");
	});

	it("connection, in the Connections screen's hint", () => {
		const hint = SCREENS.find((s) => s.label === "Connections")?.hint ?? "";
		expect(missing(connections, hint.toLowerCase())).toEqual([]);
	});

	it("settings screen, by its Settings → name", () => {
		const labels = SCREENS.map((screen) => `Settings → ${screen.label}`);
		expect(missing(labels, guide)).toEqual([]);
	});

	it("setting the search box finds, by its label", () => {
		const labels = SETTINGS_INDEX.map((entry) => entry.label);
		expect(missing(labels, guide)).toEqual([]);
	});
});
