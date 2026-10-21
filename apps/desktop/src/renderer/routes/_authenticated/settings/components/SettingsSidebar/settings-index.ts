import {
	LuBell,
	LuHardDrive,
	LuKeyboard,
	LuListOrdered,
	LuPalette,
	LuPlug,
	LuServer,
	LuSquareTerminal,
} from "react-icons/lu";

/**
 * Odin's settings screens, each with the things on it spelled out underneath,
 * so you can tell where a setting lives without opening every screen. One
 * topic per screen: who you are (Connections), a session's life here
 * (Sessions), away from here (Remote), the disk (Storage), and so on. The
 * inherited workspace sections keep their routes but have no entry here.
 */
export const SCREENS = [
	{
		to: "/settings/connections",
		label: "Connections",
		hint: "Profiles, Claude, Slack, GitHub, Jira, Notion, Gmail",
		icon: LuPlug,
	},
	{
		to: "/settings/sessions",
		label: "Sessions",
		hint: "Default folder, Claude command, prompt, limits, idle close",
		icon: LuSquareTerminal,
	},
	{
		to: "/settings/remote",
		label: "Remote",
		hint: "EC2 host, iPhone app, Remote Control",
		icon: LuServer,
	},
	{
		to: "/settings/storage",
		label: "Storage",
		hint: "Worktrees, cleanup, iCloud backup",
		icon: LuHardDrive,
	},
	{
		to: "/settings/backlog",
		label: "Backlog & Night Agent",
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
		to: "/settings/appearance",
		label: "Appearance",
		hint: "Theme, text size, chat view, links",
		icon: LuPalette,
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
		label: "Claude",
		to: "/settings/connections",
		section: "Accounts",
		keywords: "account sign in login plan claude.ai code reconnect",
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
		label: "ClickUp",
		to: "/settings/connections",
		section: "Accounts",
		keywords: "account sign in connect tasks token",
	},
	{
		label: "Default folder",
		to: "/settings/sessions",
		section: "Where they start",
		keywords: "repo repository folder checkout path directory workspace git",
	},
	{
		label: "Full Disk Access",
		to: "/settings/sessions",
		section: "Where they start",
		keywords: "permission privacy prompt music photos macos tcc allow",
	},
	{
		label: "Claude command",
		to: "/settings/sessions",
		section: "What they run",
		keywords: "launch command alias binary claude code cli wrapper",
	},
	{
		label: "Default prompt",
		to: "/settings/sessions",
		section: "What they run",
		keywords: "instructions system prompt action items task end",
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
		label: "Hold new sessions when free disk is under",
		to: "/settings/sessions",
		section: "When they start",
		keywords: "disk space full free percent launch limit queue",
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
		label: "Compact conversations moved to Idle",
		to: "/settings/sessions",
		section: "On the board",
		keywords: "compact context summary cache idle park parked waiting",
	},
	{
		label: "Read replies aloud",
		to: "/settings/sessions",
		section: "On the board",
		keywords:
			"speak speech voice talk say tts text to speech audio reply tldr chat",
	},
	{
		label: "Speech speed",
		to: "/settings/sessions",
		section: "On the board",
		keywords: "speak voice talk rate faster slower read aloud",
	},
	{
		label: "Close idle sessions after",
		to: "/settings/sessions",
		section: "On the board",
		keywords: "idle timeout hours close card",
	},
	{
		label: "Remote host",
		to: "/settings/remote",
		section: "Remote host",
		keywords:
			"ec2 aws instance ssm server host tmux lid shut connectors on the host github accounts on the host claude setup api key plan limit",
	},
	{
		label: "Phone access",
		to: "/settings/remote",
		section: "Phone",
		keywords: "iphone ios app pair qr code mobile relay",
	},
	{
		label: "Remote Control",
		to: "/settings/remote",
		section: "Claude app",
		keywords: "claude.ai code claude app phone follow selected sessions",
	},
	{
		label: "Worktrees",
		to: "/settings/storage",
		section: "Worktrees",
		keywords: "disk space storage free gb delete clean prune worktree size",
	},
	{
		label: "Delete worktrees when their PR merges",
		to: "/settings/storage",
		section: "Cleanup",
		keywords: "prune worktree merged pr disk space automatic clean",
	},
	{
		label: "iCloud Drive",
		to: "/settings/storage",
		section: "Backup",
		keywords: "backup restore copy daily",
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
		label: "Theme",
		to: "/settings/appearance",
		section: "Theme",
		keywords: "light dark bright mode color colour system appearance",
	},
	{
		label: "Custom themes",
		to: "/settings/appearance",
		section: "Theme",
		keywords: "import theme file json starter export",
	},
	{
		label: "Text size",
		to: "/settings/appearance",
		section: "Text",
		keywords: "font size bigger smaller larger zoom scale readable",
	},
	{
		label: "Show sessions as a chat",
		to: "/settings/appearance",
		section: "Sessions",
		keywords: "chat terminal claude desktop ui display view messages",
	},
	{
		label: "Fold long replies",
		to: "/settings/appearance",
		section: "Sessions",
		keywords: "fold collapse shorten long reply tldr tl;dr chat",
	},
	{
		label: "Open links inside Odin",
		to: "/settings/appearance",
		section: "Links",
		keywords: "in-app browser default external chrome safari always per site",
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
