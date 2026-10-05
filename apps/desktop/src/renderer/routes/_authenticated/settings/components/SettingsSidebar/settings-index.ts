import {
	LuBell,
	LuKeyboard,
	LuListOrdered,
	LuPlug,
	LuSquareTerminal,
} from "react-icons/lu";

/**
 * Odin's settings screens, each with the things on it spelled out underneath,
 * so you can tell where a setting lives without opening every screen. The
 * inherited workspace sections keep their routes but have no entry here.
 */
export const SCREENS = [
	{
		to: "/settings/connections",
		label: "Connections",
		hint: "Profiles, accounts, links, iCloud backup",
		icon: LuPlug,
	},
	{
		to: "/settings/sessions",
		label: "Sessions",
		hint: "Default repo, limits, idle close",
		icon: LuSquareTerminal,
	},
	{
		to: "/settings/backlog",
		label: "Backlog",
		hint: "Next in line, Night Agent, Review",
		icon: LuListOrdered,
	},
	{
		to: "/settings/ringtones",
		label: "Notifications",
		hint: "Banners, sound, reminder time",
		icon: LuBell,
	},
	{
		to: "/settings/keyboard",
		label: "Keyboard",
		hint: "Shortcuts for every screen",
		icon: LuKeyboard,
	},
] as const;

type ScreenRoute = (typeof SCREENS)[number]["to"];

export interface SettingEntry {
	/** Exactly the row's label on screen - it's how the row is found to scroll to. */
	label: string;
	to: ScreenRoute;
	section: string;
	/** Words people search for that the label doesn't say. */
	keywords?: string;
}

/**
 * Every setting the search box can find. A label here must match the
 * `data-setting` its row renders (SettingRow / SettingsSection do it from
 * their label / title); settings-index.test.ts fails when one drifts.
 */
export const SETTINGS_INDEX: SettingEntry[] = [
	{
		label: "Profiles",
		to: "/settings/connections",
		section: "Profiles",
		keywords: "profile switch add delete rename work private",
	},
	{
		label: "Slack",
		to: "/settings/connections",
		section: "Accounts",
		keywords: "account sign in connect reactions emoji queue eyes",
	},
	{
		label: "GitHub",
		to: "/settings/connections",
		section: "Accounts",
		keywords: "account sign in connect pull requests pr reviews",
	},
	{
		label: "Jira",
		to: "/settings/connections",
		section: "Accounts",
		keywords: "account sign in connect issues tickets",
	},
	{
		label: "Notion",
		to: "/settings/connections",
		section: "Accounts",
		keywords: "account sign in connect database pages teamspace",
	},
	{
		label: "Gmail",
		to: "/settings/connections",
		section: "Accounts",
		keywords: "account sign in connect email mail unread",
	},
	{
		label: "Open links inside Odin",
		to: "/settings/connections",
		section: "Links",
		keywords: "in-app browser default external chrome safari always",
	},
	{
		label: "iCloud Drive",
		to: "/settings/connections",
		section: "Backup",
		keywords: "backup restore copy daily",
	},
	{
		label: "Default repo",
		to: "/settings/sessions",
		section: "Where they start",
		keywords: "repository folder checkout path directory workspace",
	},
	{
		label: "Hold new sessions when this Mac is",
		to: "/settings/sessions",
		section: "When they start",
		keywords: "cpu load busy launch limit queue",
	},
	{
		label: "Hold new sessions when free memory is under",
		to: "/settings/sessions",
		section: "When they start",
		keywords: "memory ram gb launch limit queue",
	},
	{
		label: "Hold new sessions when this many are working",
		to: "/settings/sessions",
		section: "When they start",
		keywords: "max concurrent agents parallel launch limit queue",
	},
	{
		label: "One session per repo at a time",
		to: "/settings/sessions",
		section: "When they start",
		keywords: "checkout parallel worktree queue",
	},
	{
		label: "Rename sessions automatically",
		to: "/settings/sessions",
		section: "On the board",
		keywords: "auto rename card title name",
	},
	{
		label: "Close idle sessions after",
		to: "/settings/sessions",
		section: "On the board",
		keywords: "idle timeout hours close card",
	},
	{
		label: "How to sort it",
		to: "/settings/backlog",
		section: "Next in line",
		keywords: "order priority prompt rank ai",
	},
	{
		label: "Pin overdue tasks for",
		to: "/settings/backlog",
		section: "Next in line",
		keywords: "due date overdue days",
	},
	{
		label: "Work the backlog overnight",
		to: "/settings/backlog",
		section: "Night Agent",
		keywords: "night agent overnight enable turn on",
	},
	{
		label: "Hours",
		to: "/settings/backlog",
		section: "Night Agent",
		keywords: "night agent window from to time schedule",
	},
	{
		label: "At most",
		to: "/settings/backlog",
		section: "Night Agent",
		keywords: "night agent max sessions per night limit",
	},
	{
		label: "Instructions",
		to: "/settings/backlog",
		section: "Night Agent",
		keywords: "night agent prompt exclude",
	},
	{
		label: "Sweep the backlog every",
		to: "/settings/backlog",
		section: "Review",
		keywords: "review sweep interval hours drop",
	},
	{
		label: "Desktop banners",
		to: "/settings/ringtones",
		section: "When a session finishes",
		keywords: "banner alert macos system settings popup",
	},
	{
		label: "Sound",
		to: "/settings/ringtones",
		section: "When a session finishes",
		keywords: "sound mute ringtone audio chime",
	},
	{
		label: "Volume",
		to: "/settings/ringtones",
		section: "When a session finishes",
		keywords: "sound loud quiet",
	},
	{
		label: "Notify at",
		to: "/settings/ringtones",
		section: "Reminders",
		keywords: "reminder remind me due date time morning",
	},
	{
		label: "Shortcuts",
		to: "/settings/keyboard",
		section: "Shortcuts",
		keywords: "keyboard hotkey keys rebind",
	},
	{
		label: "Double-tap to show or hide Odin",
		to: "/settings/keyboard",
		section: "From any app",
		keywords:
			"double tap global hotkey open hide odin anywhere key mapping button synergy",
	},
];

const SCREEN_LABEL = new Map<string, string>(
	SCREENS.map((screen) => [screen.to, screen.label]),
);

export function screenLabel(to: ScreenRoute): string {
	return SCREEN_LABEL.get(to) ?? "";
}

/**
 * Settings matching every word of `query`, against label, section, screen and
 * keywords. Label hits rank first; ties keep sidebar order.
 */
export function searchSettings(query: string): SettingEntry[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];
	return SETTINGS_INDEX.flatMap((entry) => {
		const label = entry.label.toLowerCase();
		const haystack =
			`${label} ${entry.section} ${screenLabel(entry.to)} ${entry.keywords ?? ""}`.toLowerCase();
		if (!words.every((word) => haystack.includes(word))) return [];
		return [{ entry, score: words.filter((w) => label.includes(w)).length }];
	})
		.sort((a, b) => b.score - a.score)
		.map(({ entry }) => entry);
}
