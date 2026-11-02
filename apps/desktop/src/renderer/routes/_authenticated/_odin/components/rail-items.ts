import {
	HiOutlineBolt,
	HiOutlineChartBar,
	HiOutlineClipboardDocumentCheck,
	HiOutlineClock,
	HiOutlineCog6Tooth,
	HiOutlineMoon,
	HiOutlineScale,
	HiOutlineViewColumns,
} from "react-icons/hi2";

/**
 * The rail, in order. Every feed - my own tasks, Slack, Jira, PRs, Notion,
 * is one Tasks entry: they're all things to do, so they live behind a single icon
 * and switch through the strip in the view's header (FeedTabs). The per-feed
 * keys still jump straight to one; each is rebindable in Settings → Keyboard.
 */
export const RAIL_ITEMS = [
	{
		to: "/board" as const,
		hotkey: "ODIN_BOARD" as const,
		label: "Dev Board",
		Icon: HiOutlineViewColumns,
	},
	{
		to: "/all" as const,
		hotkey: "ODIN_ALL" as const,
		label: "Tasks",
		Icon: HiOutlineClipboardDocumentCheck,
	},
	// Its own entry, not a feed tab: an automation isn't waiting on you, it runs itself.
	{
		to: "/automations" as const,
		hotkey: "ODIN_AUTOMATIONS" as const,
		label: "Automations",
		Icon: HiOutlineBolt,
	},
	{
		to: "/night-agent" as const,
		label: "Night Agent",
		Icon: HiOutlineMoon,
	},
];

/**
 * Settings is app chrome, not a feed - foot of the rail. The stock entry point
 * lives in the sidebar this fork redirects away from, so without this the
 * settings screen (rail key rebinding included) is unreachable by mouse.
 */
export const SETTINGS_ITEM = {
	to: "/settings" as const,
	hotkey: "OPEN_SETTINGS" as const,
	label: "Settings",
	Icon: HiOutlineCog6Tooth,
};

/**
 * The views you visit now and then - one "More" button, always the last of
 * the top group. Each keeps its single-key hotkey.
 */
export const MORE_ITEMS = [
	// Its own page rather than a feed tab: the strip answers "what's waiting
	// on me" from a source; this answers "what can go".
	{
		to: "/review" as const,
		hotkey: "ODIN_REVIEW" as const,
		label: "Review",
		Icon: HiOutlineScale,
	},
	{
		to: "/insights" as const,
		hotkey: "ODIN_INSIGHTS" as const,
		label: "Insights",
		Icon: HiOutlineChartBar,
	},
	{
		to: "/sessions" as const,
		hotkey: "ODIN_SESSIONS" as const,
		label: "Session History",
		Icon: HiOutlineClock,
	},
];
