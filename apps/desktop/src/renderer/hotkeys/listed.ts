import type { HotkeyId } from "./registry";

/**
 * Settings -> Keyboard shows these, so each can be rebound. Every hotkey the
 * app binds belongs here: configurable.test.ts fails on one that isn't. The
 * upstream workspace/layout hotkeys this shell never binds stay out.
 */
export const LISTED_HOTKEYS: HotkeyId[] = [
	// Screens
	"ODIN_BOARD",
	"ODIN_ALL",
	"ODIN_TASKS",
	"ODIN_AUTOMATIONS",
	"ODIN_REVIEW",
	"ODIN_SLACK",
	"ODIN_JIRA",
	"ODIN_PRS",
	"ODIN_NOTION",
	"ODIN_SESSIONS",
	"ODIN_INSIGHTS",
	// Anywhere
	"ODIN_BOARD_SEARCH",
	"ODIN_SEARCH_ALL",
	"ODIN_SEARCH_ROW_MENU",
	"ODIN_NEW_TASK",
	"ODIN_ASK_CROW",
	"ODIN_COPY_LINK",
	"SUBMIT",
	"NAVIGATE_BACK",
	"NAVIGATE_FORWARD",
	// Board
	"ODIN_BOARD_UNDO",
	"PREV_SESSION",
	"NEXT_SESSION",
	// Terminal
	"FIND_IN_TERMINAL",
	"CLEAR_TERMINAL",
	"SCROLL_TO_BOTTOM",
	// Menu bar
	"OPEN_PROJECT",
	"RELOAD_WINDOW",
	"ZOOM_RESET",
	"ZOOM_IN",
	"ZOOM_OUT",
	"CLOSE_WINDOW",
	"SHOW_HOTKEYS",
	"OPEN_SETTINGS",
];
