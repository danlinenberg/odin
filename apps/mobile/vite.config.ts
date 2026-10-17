import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * The iOS app's web assets: the same screens Odin serves over Wi-Fi
 * (apps/desktop/src/renderer/mobile), built on their own into dist/ for
 * Capacitor to bundle.
 */
const desktop = resolve(import.meta.dirname, "../desktop");

/**
 * Dev only: `curl --data '<js>' localhost:5175/__eval` runs it in the page -
 * in the Simulator's app, which has no window to tap - and answers with the
 * result, over Vite's own HMR socket (renderer/mobile/main.tsx listens).
 */
function remote(): Plugin {
	const waiting = new Map<string, (value: unknown) => void>();
	return {
		name: "odin-remote",
		apply: "serve",
		configureServer(server) {
			server.ws.on("odin:result", ({ id, value }) => {
				waiting.get(id)?.(value);
				waiting.delete(id);
			});
			server.middlewares.use("/__eval", (req, res) => {
				let code = "";
				req.on("data", (chunk) => {
					code += chunk;
				});
				req.on("end", () => {
					const id = crypto.randomUUID();
					const timer = setTimeout(() => {
						waiting.delete(id);
						res.statusCode = 504;
						res.end("No page answered: is the app open in live mode?");
					}, 10_000);
					waiting.set(id, (value) => {
						clearTimeout(timer);
						res.setHeader("content-type", "application/json");
						res.end(JSON.stringify(value));
					});
					server.ws.send({
						type: "custom",
						event: "odin:eval",
						data: { id, code },
					});
				});
			});
		},
	};
}

export default defineConfig({
	root: resolve(desktop, "src/renderer/mobile"),
	base: "./",
	plugins: [
		remote(),
		tsconfigPaths({ projects: [resolve(desktop, "tsconfig.json")] }),
		tailwindcss(),
		react(),
	],
	// `bun run dev` talks to `bun run fake-odin`, same origin - or to a real
	// Odin's phone server with ODIN_API=http://127.0.0.1:4747.
	server: {
		proxy: {
			"/trpc": process.env.ODIN_API ?? "http://localhost:4799",
			"/upload": process.env.ODIN_API ?? "http://localhost:4799",
		},
	},
	build: {
		outDir: resolve(import.meta.dirname, "dist"),
		emptyOutDir: true,
	},
});
