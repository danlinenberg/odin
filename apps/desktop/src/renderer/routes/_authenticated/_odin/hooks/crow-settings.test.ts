import { expect, test } from "bun:test";
import { SETTINGS_INDEX } from "../../settings/components/SettingsSidebar/settings-index";
import { huginnSettings, whereIs } from "./crow-settings";

const settings = huginnSettings(
	{} as unknown as Parameters<typeof huginnSettings>[0],
);

test("every setting Huginn changes is a row in Settings, by its exact label", () => {
	const labels = new Set(SETTINGS_INDEX.map((entry) => entry.label));
	for (const setting of settings) expect(labels).toContain(setting.label);
	expect(new Set(settings.map((s) => s.label)).size).toBe(settings.length);
});

test("sign-ins and sessions-run-by-themselves stay out, or ask first", () => {
	const labels = settings.map((s) => s.label);
	for (const hands_off of [
		"Auto-start new tasks",
		"Remote host",
		"Phone access",
		"Claude command",
		"Default prompt",
	])
		expect(labels).not.toContain(hands_off);
	const asks = settings.filter((s) => s.asksFirst).map((s) => s.label);
	expect(asks).toEqual([
		"Merge pull requests",
		"Delete and overwrite",
		"Touch credentials and permissions",
		"Let sessions send Slack messages",
		"Work the backlog overnight",
	]);
});

test("whereIs names the screen and section", () => {
	expect(whereIs("Open links inside Odin")).toBe(
		"Settings → Appearance › Links",
	);
});
