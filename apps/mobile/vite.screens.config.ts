import { resolve } from "node:path";
import { mergeConfig } from "vite";
import base from "./vite.config";

/**
 * The phone's screens as one app.js and one app.css (dist-screens/), for Odin
 * to send a paired phone over the channel (main/lib/phone/screens.ts). The
 * phone runs them from text (renderer/mobile/boot.ts), so nothing may load a
 * second file: dynamic imports and assets go inline.
 */
const mobile = resolve(import.meta.dirname, "../desktop/src/renderer/mobile");

export default mergeConfig(base, {
	build: {
		outDir: resolve(import.meta.dirname, "dist-screens"),
		emptyOutDir: true,
		cssCodeSplit: false,
		assetsInlineLimit: () => true,
		rollupOptions: {
			input: resolve(mobile, "main.tsx"),
			output: {
				inlineDynamicImports: true,
				entryFileNames: "app.js",
				assetFileNames: "app[extname]",
			},
		},
	},
});
