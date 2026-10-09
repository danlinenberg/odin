import { describe, expect, it } from "bun:test";
// biome-ignore lint/style/noRestrictedImports: test file needs fs/path for source verification
import { readdirSync, readFileSync } from "node:fs";
// biome-ignore lint/style/noRestrictedImports: test file needs fs/path for source verification
import { join } from "node:path";
import { SCREENS, SETTINGS_INDEX, searchSettings } from "./settings-index";

const SETTINGS_DIR = join(import.meta.dir, "../..");

/** Every .tsx under a screen's route folder, concatenated. */
function screenSource(to: string): string {
	const dir = join(SETTINGS_DIR, to.replace("/settings/", ""));
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".tsx"))
		.map((file) => readFileSync(join(dir, file), "utf8"))
		.join("\n");
}

describe("settings index", () => {
	it("names only labels its screen renders with a data-setting", () => {
		for (const entry of SETTINGS_INDEX) {
			const source = screenSource(entry.to);
			// SettingRow label=, SettingsSection title=, account META name:, or
			// an explicit data-setting - each renders data-setting from it.
			const rendered = [
				`label="${entry.label}"`,
				`title="${entry.label}"`,
				`name: "${entry.label}"`,
				`data-setting="${entry.label}"`,
			].some((form) => source.includes(form));
			expect({ label: entry.label, rendered }).toEqual({
				label: entry.label,
				rendered: true,
			});
		}
	});

	it("covers every screen", () => {
		for (const screen of SCREENS) {
			expect(SETTINGS_INDEX.some((e) => e.to === screen.to)).toBe(true);
		}
	});

	it("matches every word, label hits first", () => {
		expect(searchSettings("")).toEqual([]);
		expect(searchSettings("night agent hours")[0]?.label).toBe("Hours");
		expect(searchSettings("memory")[0]?.label).toBe(
			"Hold new sessions when free memory is under",
		);
		// "Sound" is a label hit; "Volume" only matches by keyword.
		expect(searchSettings("sound").map((e) => e.label)).toEqual([
			"Sound",
			"Volume",
		]);
		expect(searchSettings("light mode")[0]?.label).toBe("Theme");
	});
});
