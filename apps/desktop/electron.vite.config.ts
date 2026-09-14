import { resolve } from "node:path";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import reactPlugin from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";
import { config } from "dotenv";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import injectProcessEnvPlugin from "rollup-plugin-inject-process-env";
import tsconfigPathsPlugin from "vite-tsconfig-paths";
import { dependencies, resources, version } from "./package.json";
import { mainExternalizedDependencies } from "./runtime-dependencies";
import {
	coalesceFullReloadPlugin,
	copyResourcesPlugin,
	defineEnv,
	devPath,
} from "./vite/helpers";

// override: true ensures .env values take precedence over inherited env vars.
// Odin fork: packaged builds (ODIN_PACKAGE=1) must not inhale the dev
// worktree's .env — it bakes dev identity, local URLs, and ports into the app.
if (!process.env.ODIN_PACKAGE) {
	config({
		path: resolve(__dirname, "../../.env"),
		override: true,
		quiet: true,
	});
}

const DEV_SERVER_PORT = Number(process.env.DESKTOP_VITE_PORT);

// Validate required env vars at build time using the Zod schema (single source of truth)
await import("./src/main/env.main");

const tsconfigPaths = tsconfigPathsPlugin({
	projects: [resolve("tsconfig.json")],
});

const workspaceDependencies = Object.keys(dependencies).filter((dependency) =>
	dependency.startsWith("@odin/"),
);

// Sentry plugin for uploading sourcemaps (only in CI with auth token)
const sentryPlugin = process.env.SENTRY_AUTH_TOKEN
	? sentryVitePlugin({
			org: "danlinenberg",
			project: "desktop",
			authToken: process.env.SENTRY_AUTH_TOKEN,
			release: { name: version },
		})
	: null;

export default defineConfig({
	main: {
		plugins: [tsconfigPaths, copyResourcesPlugin()],

		define: {
			"process.env.NODE_ENV": defineEnv(process.env.NODE_ENV, "production"),
			"process.env.SKIP_ENV_VALIDATION": defineEnv(
				process.env.SKIP_ENV_VALIDATION,
				"",
			),
			"process.env.SENTRY_DSN_DESKTOP": defineEnv(
				process.env.SENTRY_DSN_DESKTOP,
			),
			"process.env.SENTRY_DSN_HOST_SERVICE": defineEnv(
				process.env.SENTRY_DSN_HOST_SERVICE,
			),
			// Must match renderer for analytics in main process
			"process.env.NEXT_PUBLIC_POSTHOG_KEY": defineEnv(
				process.env.NEXT_PUBLIC_POSTHOG_KEY,
			),
			"process.env.NEXT_PUBLIC_POSTHOG_HOST": defineEnv(
				process.env.NEXT_PUBLIC_POSTHOG_HOST,
			),
			"process.env.DESKTOP_VITE_PORT": defineEnv(process.env.DESKTOP_VITE_PORT),
			"process.env.DESKTOP_NOTIFICATIONS_PORT": defineEnv(
				process.env.DESKTOP_NOTIFICATIONS_PORT,
			),
			"process.env.ELECTRIC_PORT": defineEnv(process.env.ELECTRIC_PORT),
			"process.env.ODIN_WORKSPACE_NAME": defineEnv(
				// Odin fork: never bake the dev-worktree identity into packaged builds
				process.env.ODIN_PACKAGE ? undefined : process.env.ODIN_WORKSPACE_NAME,
			),
			// Odin fork: the Slack OAuth app, compiled in, so a packaged build can
			// offer one-click sign-in without every machine holding credentials.
			// Deliberately separate _BAKED keys: replacing the plain ODIN_SLACK_*
			// names would make them literals and stop a runtime env var from ever
			// winning. The "" fallback keeps the emitted value a valid string —
			// defineEnv(undefined) returns undefined, which esbuild won't inline.
			"process.env.ODIN_SLACK_CLIENT_ID_BAKED": defineEnv(
				process.env.ODIN_SLACK_CLIENT_ID,
				"",
			),
			"process.env.ODIN_SLACK_CLIENT_SECRET_BAKED": defineEnv(
				process.env.ODIN_SLACK_CLIENT_SECRET,
				"",
			),
			"process.env.ODIN_SLACK_REDIRECT_URL_BAKED": defineEnv(
				process.env.ODIN_SLACK_REDIRECT_URL,
				"",
			),
			// GitHub's device flow needs only a client id, and it isn't a secret —
			// the flow has none. Baking it is what makes that row one click.
			"process.env.ODIN_GITHUB_CLIENT_ID_BAKED": defineEnv(
				process.env.ODIN_GITHUB_CLIENT_ID,
				"",
			),
			"process.env.ODIN_NOTION_CLIENT_ID_BAKED": defineEnv(
				process.env.ODIN_NOTION_CLIENT_ID,
				"",
			),
			"process.env.ODIN_NOTION_CLIENT_SECRET_BAKED": defineEnv(
				process.env.ODIN_NOTION_CLIENT_SECRET,
				"",
			),
			"process.env.ODIN_NOTION_REDIRECT_URL_BAKED": defineEnv(
				process.env.ODIN_NOTION_REDIRECT_URL,
				"",
			),
			"process.env.ODIN_JIRA_CLIENT_ID_BAKED": defineEnv(
				process.env.ODIN_JIRA_CLIENT_ID,
				"",
			),
			"process.env.ODIN_JIRA_CLIENT_SECRET_BAKED": defineEnv(
				process.env.ODIN_JIRA_CLIENT_SECRET,
				"",
			),
			"process.env.ODIN_JIRA_REDIRECT_URL_BAKED": defineEnv(
				process.env.ODIN_JIRA_REDIRECT_URL,
				"",
			),
		},

		build: {
			sourcemap: true,
			rollupOptions: {
				input: {
					index: resolve("src/main/index.ts"),
					// Terminal host daemon process - runs separately for terminal persistence
					"terminal-host": resolve("src/main/terminal-host/index.ts"),
					// PTY subprocess - spawned by terminal-host for each terminal
					"pty-subprocess": resolve("src/main/terminal-host/pty-subprocess.ts"),
					// Worker-thread entrypoint for heavy git/status computations
					"git-task-worker": resolve("src/main/git-task-worker.ts"),
					// Workspace service - local HTTP/tRPC server per org
					"host-service": resolve("src/main/host-service/index.ts"),
					// pty-daemon - long-lived per-org Unix-socket server that owns PTYs.
					// Spawned by PtyDaemonCoordinator; survives host-service restarts.
					"pty-daemon": resolve("src/main/pty-daemon/index.ts"),
					// host-service worker thread — emitted side-by-side with
					// host-service.js so the pool's script resolution finds it.
					"host-worker": resolve("src/main/host-worker/index.ts"),
				},
				output: {
					dir: resolve(devPath, "main"),
				},
				external: ["electron", ...mainExternalizedDependencies],
				plugins: [sentryPlugin].filter(Boolean),
			},
		},
		resolve: {
			alias: {
				// @xterm/headless 6.0.0 has a packaging bug: `module` field points to
				// non-existent `lib/xterm.mjs`. Force Vite to use the CJS entry instead.
				"@xterm/headless": "@xterm/headless/lib-headless/xterm-headless.js",
			},
		},
	},

	preload: {
		plugins: [
			tsconfigPaths,
			externalizeDepsPlugin({
				exclude: [
					"trpc-electron",
					"@sentry/electron",
					...workspaceDependencies,
				],
			}),
		],

		define: {
			"process.env.NODE_ENV": defineEnv(process.env.NODE_ENV, "production"),
			"process.env.SKIP_ENV_VALIDATION": defineEnv(
				process.env.SKIP_ENV_VALIDATION,
				"",
			),
			__APP_VERSION__: defineEnv(version),
		},

		build: {
			outDir: resolve(devPath, "preload"),
			rollupOptions: {
				input: {
					index: resolve("src/preload/index.ts"),
				},
			},
		},
	},

	renderer: {
		define: {
			"process.env.NODE_ENV": defineEnv(process.env.NODE_ENV),
			"process.env.SKIP_ENV_VALIDATION": defineEnv(
				process.env.SKIP_ENV_VALIDATION,
				"",
			),
			"process.platform": defineEnv(process.platform),
			"import.meta.env.DEV_SERVER_PORT": defineEnv(String(DEV_SERVER_PORT)),
			"import.meta.env.NEXT_PUBLIC_POSTHOG_KEY": defineEnv(
				process.env.NEXT_PUBLIC_POSTHOG_KEY,
			),
			"import.meta.env.NEXT_PUBLIC_POSTHOG_HOST": defineEnv(
				process.env.NEXT_PUBLIC_POSTHOG_HOST,
			),
			"import.meta.env.SENTRY_DSN_DESKTOP": defineEnv(
				process.env.SENTRY_DSN_DESKTOP,
			),
			"process.env.DESKTOP_VITE_PORT": defineEnv(process.env.DESKTOP_VITE_PORT),
			"process.env.DESKTOP_NOTIFICATIONS_PORT": defineEnv(
				process.env.DESKTOP_NOTIFICATIONS_PORT,
			),
			"process.env.ELECTRIC_PORT": defineEnv(process.env.ELECTRIC_PORT),
			"process.env.ODIN_WORKSPACE_NAME": defineEnv(
				// Odin fork: never bake the dev-worktree identity into packaged builds
				process.env.ODIN_PACKAGE ? undefined : process.env.ODIN_WORKSPACE_NAME,
			),
		},

		server: {
			port: DEV_SERVER_PORT,
			strictPort: false,
		},

		plugins: [
			tanstackRouter({
				target: "react",
				routesDirectory: resolve("src/renderer/routes"),
				generatedRouteTree: resolve("src/renderer/routeTree.gen.ts"),
				indexToken: "page",
				routeToken: "layout",
				autoCodeSplitting: true,
				routeFileIgnorePattern:
					"^(?!(__root|page|layout)\\.tsx$).*\\.(tsx?|jsx?)$",
			}),
			tsconfigPaths,
			tailwindcss(),
			codeInspectorPlugin({
				bundler: "vite",
				hotKeys: ["altKey"],
				hideConsole: true,
				port: Number(process.env.CODE_INSPECTOR_PORT) || undefined,
			}),
			reactPlugin(),
			coalesceFullReloadPlugin(),
		],

		worker: {
			format: "es",
		},

		publicDir: resolve(resources, "public"),

		build: {
			sourcemap: true,
			outDir: resolve(devPath, "renderer"),

			rollupOptions: {
				plugins: [
					injectProcessEnvPlugin({
						NODE_ENV: "production",
						platform: process.platform,
					}),
					sentryPlugin,
				].filter(Boolean),

				input: {
					index: resolve("src/renderer/index.html"),
				},
			},
		},
	},
});
