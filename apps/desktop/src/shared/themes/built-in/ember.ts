import type { Theme } from "../types";

/**
 * Dark theme - Graphite. A flight deck, not a nightclub: warm graphite
 * neutrals, bone-white ink, and no brand hue at all. Colour in Odin means
 * state - the four status hues in globals.css (--working, --attention,
 * --success, --danger) are the only colour on screen, so the eye lands on
 * what is running, waiting or broken. Primary actions are inked, not tinted.
 */
export const darkTheme: Theme = {
	id: "dark",
	name: "Graphite",
	author: "Odin",
	type: "dark",
	isBuiltIn: true,

	ui: {
		// Core - graphite with a hair of warmth, so long sessions read as
		// paper-under-lamp rather than blue screen.
		background: "#131312",
		foreground: "#ecebe6",
		card: "#1a1a18",
		cardForeground: "#ecebe6",
		popover: "#1e1e1c",
		popoverForeground: "#ecebe6",

		// Primary - ink. The one button a view exists for is bone on graphite.
		primary: "#ecebe6",
		primaryForeground: "#131312",

		// Secondary - the raised neutral every quiet button and chip sits on
		secondary: "#222220",
		secondaryForeground: "#ecebe6",

		// Muted
		muted: "#222220",
		mutedForeground: "#a09f97",

		// Accent - hover fill for menu rows, and the "selected" surface
		accent: "#2b2b28",
		accentForeground: "#ecebe6",

		// Tertiary - rail, top bar, board columns: the chrome sits below the work
		tertiary: "#0f0f0e",
		tertiaryActive: "#1d1d1b",

		// Destructive - the same red as a failed session
		destructive: "#f0716a",
		destructiveForeground: "#131312",

		// Borders - hairlines, one step off the surface
		border: "#2a2a27",
		input: "#3a3a36",
		ring: "#ecebe6",

		// Sidebar
		sidebar: "#0f0f0e",
		sidebarForeground: "#ecebe6",
		sidebarPrimary: "#ecebe6",
		sidebarPrimaryForeground: "#131312",
		sidebarAccent: "#222220",
		sidebarAccentForeground: "#ecebe6",
		sidebarBorder: "#2a2a27",
		sidebarRing: "#ecebe6",

		// Charts - ink first, then the four status hues
		chart1: "#c9c8c0",
		chart2: "#6aa6f8",
		chart3: "#5cc98f",
		chart4: "#e9b44c",
		chart5: "#f0716a",

		// Search highlights - a marker pen, not the brand
		highlightMatch: "rgba(233, 180, 76, 0.22)",
		highlightActive: "rgba(233, 180, 76, 0.5)",

		// Brand highlight (PRO badge and friends) - ink
		highlight: "#ecebe6",
		highlightForeground: "#131312",
	},

	terminal: {
		background: "#131312",
		foreground: "#ecebe6",
		cursor: "#ecebe6",
		cursorAccent: "#131312",
		selectionBackground: "rgba(236, 235, 230, 0.18)",

		// Standard ANSI colors
		black: "#1e1e1c",
		red: "#f0716a",
		green: "#5cc98f",
		yellow: "#e9b44c",
		blue: "#6aa6f8",
		magenta: "#c79bf0",
		cyan: "#62c6d4",
		white: "#d6d5ce",

		// Bright ANSI colors
		brightBlack: "#6f6e67",
		brightRed: "#ff958e",
		brightGreen: "#86dcac",
		brightYellow: "#f5cb74",
		brightBlue: "#93bffb",
		brightMagenta: "#dbbaf7",
		brightCyan: "#8ad8e2",
		brightWhite: "#f6f5f0",
	},

	editor: {
		syntax: {
			comment: "#85847c",
		},
	},
};
