import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
	appId: "com.danlinenberg.odin",
	appName: "Odin",
	webDir: "dist",
	backgroundColor: "#0e0e11",
	plugins: {
		// Native requests: the bundled page (capacitor://localhost) can't fetch
		// the Mac's http:// server itself - mixed content, and CORS.
		CapacitorHttp: { enabled: true },
	},
};

export default config;
