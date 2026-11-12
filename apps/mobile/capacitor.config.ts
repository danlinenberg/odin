import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
	appId: "com.danlinenberg.odin",
	appName: "Odin",
	webDir: "dist",
	backgroundColor: "#0e0e11",
	android: {
		// The screens load from https://localhost and reach Odin on the Wi-Fi
		// over ws:// (the channel is end to end encrypted either way); Android's
		// web view blocks that mixed content unless allowed.
		allowMixedContent: true,
	},
	plugins: {
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
