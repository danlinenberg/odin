import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, normalize, resolve } from "node:path";
import type { Plugin } from "vite";

import { main, resources } from "../package.json";

export const devPath = normalize(dirname(main)).split(/\/|\\/g)[0];

function copyDir({ src, dest }: { src: string; dest: string }): void {
	if (!existsSync(src)) return;

	if (existsSync(dest)) {
		rmSync(dest, { recursive: true });
	}
	mkdirSync(dest, { recursive: true });
	cpSync(src, dest, { recursive: true });
}

export function defineEnv(
	value: string | undefined,
	fallback?: string,
): string {
	return JSON.stringify(value ?? fallback);
}

const RESOURCES_TO_COPY = [
	{
		src: resolve(__dirname, "..", resources, "sounds"),
		dest: resolve(__dirname, "..", devPath, "resources/sounds"),
	},
	{
		src: resolve(__dirname, "..", resources, "tray"),
		dest: resolve(__dirname, "..", devPath, "resources/tray"),
	},
	{
		src: resolve(__dirname, "..", resources, "browser-extension"),
		dest: resolve(__dirname, "..", devPath, "resources/browser-extension"),
	},
	{
		src: resolve(__dirname, "../../../packages/local-db/drizzle"),
		dest: resolve(__dirname, "..", devPath, "resources/migrations"),
	},
	{
		src: resolve(__dirname, "../../../packages/host-service/drizzle"),
		dest: resolve(__dirname, "..", devPath, "resources/host-migrations"),
	},
	{
		src: resolve(__dirname, "../src/main/lib/agent-setup/templates"),
		dest: resolve(__dirname, "..", devPath, "main/templates"),
	},
	// Must come after the templates copy above: copyDir wipes its dest, and
	// this nests inside it. Bundles the repo's Claude Code plugin so
	// agent-setup can provision its skills into user environments at boot.
	{
		src: resolve(__dirname, "../../../plugins/odin"),
		dest: resolve(__dirname, "..", devPath, "main/templates/plugin"),
	},
];

/**
 * Copies resources to dist/ for preview/production mode.
 * In preview mode, __dirname resolves relative to dist/main, so resources
 * need to be copied there for the main process to access them.
 */
export function copyResourcesPlugin(): Plugin {
	return {
		name: "copy-resources",
		writeBundle() {
			for (const resource of RESOURCES_TO_COPY) {
				copyDir(resource);
			}
		},
	};
}

/**
 * Coalesces Vite's dev full page reloads.
 *
 * This checkout is shared with agent sessions that save renderer files
 * constantly, and some route modules — the board is one — have no usable Fast
 * Refresh boundary, so Vite gives up on HMR and full-reloads the renderer
 * instead. A full reload reboots the whole app: every pane remounts and
 * re-attaches, the board flashes, and it reads as "Odin restarted" mid-work.
 * Bursts of ten reloads inside a minute were normal.
 *
 * The reload still lands, just once the saves go quiet — or after `maxHoldMs`,
 * so a fleet that never goes quiet still picks changes up. Hot updates pass
 * straight through, untouched.
 *
 * While a session pane is open (the board sends `odin:session-pane`), every
 * payload — hot updates too — is held until it closes, so nothing remounts the
 * terminal you're typing into. Closing it replays them; a held full reload
 * supersedes the updates and lands right away.
 *
 * ponytail: coalescing, not a boundary fix — whatever module dead-ends the
 * board's HMR chain still dead-ends it, and Vite still logs `page reload
 * <file>` naming it. Chase that if a held reload ever costs more than a calm
 * app does.
 */
export function coalesceFullReloadPlugin({
	quietMs = 10_000,
	maxHoldMs = 60_000,
}: {
	quietMs?: number;
	maxHoldMs?: number;
} = {}): Plugin {
	return {
		name: "odin-coalesce-full-reload",
		apply: "serve",
		configureServer(server) {
			const hot = server.environments?.client?.hot ?? server.hot;
			const send = hot.send.bind(hot) as (...args: unknown[]) => void;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let heldSince = 0;

			let paneOpen = false;
			let held: unknown[][] = [];
			hot.on("odin:session-pane", (open: boolean) => {
				paneOpen = open;
				if (open) return;
				const queued = held;
				held = [];
				const reload = queued.find(
					(a) => (a[0] as { type?: string })?.type === "full-reload",
				);
				if (reload) {
					server.config.logger.info("odin: reloading — session pane closed");
					send(...reload);
				} else for (const a of queued) send(...a);
			});
			// A client that reconnects loads fresh modules — whatever it held is moot.
			hot.on("vite:client:disconnect", () => {
				paneOpen = false;
				held = [];
			});

			hot.send = ((...args: unknown[]) => {
				const payload = args[0] as { type?: string } | undefined;
				if (paneOpen) {
					held.push(args);
					return;
				}
				if (args.length !== 1 || payload?.type !== "full-reload") {
					send(...args);
					return;
				}

				const now = Date.now();
				if (!timer) heldSince = now;

				if (now - heldSince >= maxHoldMs) {
					clearTimeout(timer);
					timer = undefined;
					server.config.logger.info(
						`odin: reloading — renderer saves never went quiet (held ${Math.round(maxHoldMs / 1000)}s)`,
					);
					send(...args);
					return;
				}

				clearTimeout(timer);
				timer = setTimeout(() => {
					timer = undefined;
					if (paneOpen) {
						held.push(args);
						return;
					}
					server.config.logger.info(
						"odin: reloading — renderer saves went quiet",
					);
					send(...args);
				}, quietMs);
			}) as typeof hot.send;
		},
	};
}
