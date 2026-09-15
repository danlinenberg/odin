import { describe, expect, it } from "bun:test";
import {
	getAllowedSectionsForVariant,
	getVisibleItemsForSection,
	SETTING_ITEM_ID,
} from "./settings-items";

describe("variant gating", () => {
	it("keeps shared items in both variants", () => {
		for (const isV2 of [false, true]) {
			expect(
				getVisibleItemsForSection({ section: "ringtones", isV2 }),
			).toContain(SETTING_ITEM_ID.RINGTONES_NOTIFICATION);
		}
	});

	it("drops items belonging to the other variant", () => {
		expect(
			getVisibleItemsForSection({ section: "keyboard", isV2: true }),
		).toContain(SETTING_ITEM_ID.KEYBOARD_SHORTCUTS);
		// `links` is v2-only, and hidden entirely by the visible-section allowlist.
		expect(getVisibleItemsForSection({ section: "links", isV2: true })).toEqual(
			[],
		);
	});

	it("only allows sections on the visible allowlist", () => {
		expect([...getAllowedSectionsForVariant(false)].sort()).toEqual([
			"connections",
			"keyboard",
			"ringtones",
		]);
	});
});
