import type { Theme } from "../types";

/**
 * Molokai theme - Tomas Restrepo's Vim port of Monokai, on a darker base
 */
export const molokaiTheme: Theme = {
	id: "molokai",
	name: "Molokai",
	author: "Tomas Restrepo",
	type: "dark",
	isBuiltIn: true,
	description: "Vim's darker take on Monokai",

	ui: {
		background: "#1b1d1e",
		foreground: "#f8f8f2",
		card: "#232526",
		cardForeground: "#f8f8f2",
		popover: "#232526",
		popoverForeground: "#f8f8f2",
		primary: "#f92672",
		primaryForeground: "#f8f8f2",
		secondary: "#293739",
		secondaryForeground: "#f8f8f2",
		muted: "#232526",
		mutedForeground: "#a0a8aa",
		accent: "#403d3d",
		accentForeground: "#f8f8f2",
		tertiary: "#161819",
		tertiaryActive: "#232526",
		destructive: "#f92672",
		destructiveForeground: "#f8f8f2",
		border: "#455354",
		input: "#455354",
		ring: "#66d9ef",
		sidebar: "#161819",
		sidebarForeground: "#f8f8f2",
		sidebarPrimary: "#f92672",
		sidebarPrimaryForeground: "#f8f8f2",
		sidebarAccent: "#232526",
		sidebarAccentForeground: "#f8f8f2",
		sidebarBorder: "#455354",
		sidebarRing: "#66d9ef",
		chart1: "#f92672",
		chart2: "#a6e22e",
		chart3: "#66d9ef",
		chart4: "#fd971f",
		chart5: "#ae81ff",

		// Search highlights - Molokai's string yellow
		highlightMatch: "rgba(230, 219, 116, 0.25)",
		highlightActive: "rgba(230, 219, 116, 0.55)",

		// Brand highlight - Molokai's keyword pink
		highlight: "#f92672",
		highlightForeground: "#f8f8f2",
	},

	terminal: {
		background: "#1b1d1e",
		foreground: "#f8f8f2",
		cursor: "#f8f8f0",
		cursorAccent: "#1b1d1e",
		selectionBackground: "rgba(64, 61, 61, 0.8)",

		black: "#1b1d1e",
		red: "#f92672",
		green: "#a6e22e",
		yellow: "#e6db74",
		blue: "#66d9ef",
		magenta: "#ae81ff",
		cyan: "#a1efe4",
		white: "#f8f8f2",

		brightBlack: "#7e8e91",
		brightRed: "#ff5995",
		brightGreen: "#b6e354",
		brightYellow: "#feed6c",
		brightBlue: "#8cedff",
		brightMagenta: "#c4a8ff",
		brightCyan: "#b8f4ec",
		brightWhite: "#ffffff",
	},
};
