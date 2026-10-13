import type { Theme } from "../types";

/**
 * Light theme - Paper. The Graphite theme printed: warm off-white paper,
 * near-black ink, white cards that sit a step above the page. Same rule as
 * the dark one - colour means state, never decoration - with the status hues
 * deepened in globals.css so they hold contrast on paper.
 */
export const lightTheme: Theme = {
	id: "light",
	name: "Paper",
	author: "Odin",
	type: "light",
	isBuiltIn: true,

	ui: {
		background: "#f6f5f1",
		foreground: "#1b1b19",
		card: "#ffffff",
		cardForeground: "#1b1b19",
		popover: "#ffffff",
		popoverForeground: "#1b1b19",

		// Primary - ink on paper
		primary: "#1b1b19",
		primaryForeground: "#f6f5f1",

		secondary: "#ecebe5",
		secondaryForeground: "#1b1b19",
		muted: "#ecebe5",
		mutedForeground: "#64635b",
		accent: "#e4e3dc",
		accentForeground: "#1b1b19",

		// Tertiary - rail, top bar, board columns
		tertiary: "#eeede7",
		tertiaryActive: "#e2e1da",

		destructive: "#c3352f",
		destructiveForeground: "#ffffff",

		border: "#dedcd4",
		input: "#cfcdc4",
		ring: "#1b1b19",

		sidebar: "#eeede7",
		sidebarForeground: "#1b1b19",
		sidebarPrimary: "#1b1b19",
		sidebarPrimaryForeground: "#f6f5f1",
		sidebarAccent: "#e4e3dc",
		sidebarAccentForeground: "#1b1b19",
		sidebarBorder: "#dedcd4",
		sidebarRing: "#1b1b19",

		chart1: "#3d3c37",
		chart2: "#2261c4",
		chart3: "#1d7d4d",
		chart4: "#975e08",
		chart5: "#c3352f",

		// Search highlights - a highlighter pen
		highlightMatch: "rgba(245, 196, 66, 0.4)",
		highlightActive: "rgba(240, 160, 40, 0.6)",

		highlight: "#1b1b19",
		highlightForeground: "#f6f5f1",
	},

	terminal: {
		background: "#fbfaf7",
		foreground: "#24241f",
		cursor: "#1b1b19",
		cursorAccent: "#fbfaf7",
		selectionBackground: "rgba(27, 27, 25, 0.14)",

		black: "#24241f",
		red: "#c3352f",
		green: "#1d7d4d",
		yellow: "#94600a",
		blue: "#2261c4",
		magenta: "#8a4bb8",
		cyan: "#11788a",
		white: "#a9a8a0",

		brightBlack: "#6f6e67",
		brightRed: "#dc4a43",
		brightGreen: "#26935c",
		brightYellow: "#b07812",
		brightBlue: "#3b78d8",
		brightMagenta: "#9f62cc",
		brightCyan: "#1b8ea2",
		brightWhite: "#d4d3cb",
	},

	editor: {
		syntax: {
			comment: "#7b7a72",
		},
	},
};
