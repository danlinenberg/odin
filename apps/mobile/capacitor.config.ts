import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
	appId: "com.danlinenberg.odin",
	appName: "Odin",
	webDir: "dist",
	backgroundColor: "#0e0e11",
	plugins: {
		// Native requests: the bundled page (capacitor://localhost) can't fetch
		// the Mac's http:// server itself - mixed content, and CORS. Not in live
		// mode: the page and the API share the dev server's origin there, and
		// CapacitorHttp's capacitor:// detour would be the cross-origin call.
		CapacitorHttp: { enabled: !process.env.ODIN_LIVE_URL },
		// The web view shrinks above the keyboard, so the header stays on screen
		// instead of iOS scrolling the whole page up under the status bar.
		Keyboard: { resize: "native" },
	},
	// scripts/sim.sh --live: load the screens from `bun run dev`, so an edit
	// shows in the Simulator without a rebuild. A plain sync drops it again.
	...(process.env.ODIN_LIVE_URL && {
		server: { url: process.env.ODIN_LIVE_URL, cleartext: true },
	}),
};

export default config;
