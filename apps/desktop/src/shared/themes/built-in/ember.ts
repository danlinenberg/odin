import type { Theme } from "../types";

/**
 * Dark theme — Odin's own palette. Cool ink neutrals, one brand colour
 * (violet), and four status hues that live in globals.css (--working,
 * --attention, --success, --danger) so every page names a state the same way.
 */
export const darkTheme: Theme = {
	id: "dark",
	name: "Dark",
	author: "Odin",
	type: "dark",
	isBuiltIn: true,

	ui: {
		// Core — cool ink neutrals, a hair of blue so the violet accent sits in
		// the same family instead of fighting a warm brown.
		background: "#0e0e11",
		foreground: "#ececf1",
		card: "#16161b",
		cardForeground: "#ececf1",
		popover: "#1a1a20",
		popoverForeground: "#ececf1",

		// Primary — Odin violet: the one brand colour. Primary buttons,
		// switches, focus, links and "selected" all draw from it.
		primary: "#a394ff",
		primaryForeground: "#0e0e11",

		// Secondary — the raised neutral every quiet button and chip sits on
		secondary: "#1f1f26",
		secondaryForeground: "#ececf1",

		// Muted
		muted: "#1f1f26",
		mutedForeground: "#9696a3",

		// Accent — hover fill for menu rows
		accent: "#25252d",
		accentForeground: "#ececf1",

		// Tertiary — rail, top bar, board columns
		tertiary: "#121216",
		tertiaryActive: "#1f1f26",

		// Destructive — the same red as a failed session
		destructive: "#f0647a",
		destructiveForeground: "#fff1f3",

		// Borders
		border: "#26262e",
		input: "#2e2e37",
		ring: "#a394ff",

		// Sidebar
		sidebar: "#121216",
		sidebarForeground: "#ececf1",
		sidebarPrimary: "#a394ff",
		sidebarPrimaryForeground: "#0e0e11",
		sidebarAccent: "#1f1f26",
		sidebarAccentForeground: "#ececf1",
		sidebarBorder: "#26262e",
		sidebarRing: "#a394ff",

		// Charts — the brand, then the four status hues
		chart1: "#a394ff",
		chart2: "#5aa9ff",
		chart3: "#3ecf8e",
		chart4: "#f5b83d",
		chart5: "#f0647a",

		// Search highlights
		highlightMatch: "rgba(163, 148, 255, 0.2)",
		highlightActive: "rgba(163, 148, 255, 0.45)",

		// Brand highlight
		highlight: "#a394ff",
		highlightForeground: "#0e0e11",
	},

	terminal: {
		background: "#0e0e11",
		foreground: "#ececf1",
		cursor: "#a394ff",
		cursorAccent: "#0e0e11",
		selectionBackground: "rgba(163, 148, 255, 0.28)",

		// Standard ANSI colors
		black: "#16161b",
		red: "#f0647a",
		green: "#3ecf8e",
		yellow: "#f5b83d",
		blue: "#5aa9ff",
		magenta: "#c49bff",
		cyan: "#4fd1d9",
		white: "#ececf1",

		// Bright ANSI colors
		brightBlack: "#6e6e7b",
		brightRed: "#ff8a9b",
		brightGreen: "#6ee0ab",
		brightYellow: "#ffcd6b",
		brightBlue: "#86c1ff",
		brightMagenta: "#d6b8ff",
		brightCyan: "#7fe3e9",
		brightWhite: "#ffffff",
	},

	editor: {
		syntax: {
			comment: "#8b8b98",
		},
	},
};
