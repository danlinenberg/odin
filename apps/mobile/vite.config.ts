import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * The iOS app's web assets: the same screens Odin serves over Wi-Fi
 * (apps/desktop/src/renderer/mobile), built on their own into dist/ for
 * Capacitor to bundle.
 */
const desktop = resolve(import.meta.dirname, "../desktop");

export default defineConfig({
	root: resolve(desktop, "src/renderer/mobile"),
	base: "./",
	plugins: [
		tsconfigPaths({ projects: [resolve(desktop, "tsconfig.json")] }),
		tailwindcss(),
		react(),
	],
	build: {
		outDir: resolve(import.meta.dirname, "dist"),
		emptyOutDir: true,
	},
});
