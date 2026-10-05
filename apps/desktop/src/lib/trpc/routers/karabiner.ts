import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { app } from "electron";
import { DOUBLE_TAP_KEYS, type DoubleTapKey } from "shared/double-tap-keys";
import { z } from "zod";
import { publicProcedure, router } from "..";

/**
 * Double-tap a modifier to open Odin from any app. Electron can't see a
 * modifier double-tap without a native key monitor, so the rule lives in
 * Karabiner-Elements, and Karabiner's own config file is the only record of
 * the setting, key included. Karabiner reloads that file whenever it changes.
 */
const IS_OURS = /^Double-tap .+ to open Odin$/;
const TAPPED = "odin_double_tapped";
const CONFIG_PATH = join(homedir(), ".config/karabiner/karabiner.json");

interface KarabinerConfig {
	profiles: {
		selected?: boolean;
		complex_modifications?: { rules?: KarabinerRule[] };
	}[];
}

interface KarabinerRule {
	description?: string;
	manipulators?: { from?: { key_code?: string } }[];
}

/**
 * The first press sets a flag that any other key, or 500ms, clears. The
 * second press opens Odin only if it's released alone, so the key still works
 * as a modifier: ⌘C then ⌘V never opens anything.
 */
function doubleTapRule(key: DoubleTapKey, command: string) {
	const tapped = (value: number) => ({ set_variable: { name: TAPPED, value } });
	const from = { key_code: key, modifiers: { optional: ["any"] } };
	return {
		description: `Double-tap ${key.replace("_", " ")} to open Odin`,
		manipulators: [
			{
				type: "basic",
				conditions: [{ type: "variable_if", name: TAPPED, value: 1 }],
				from,
				to: [{ key_code: key }],
				to_if_alone: [{ shell_command: command }],
			},
			{
				type: "basic",
				from,
				to: [tapped(1), { key_code: key }],
				to_delayed_action: {
					to_if_invoked: [tapped(0)],
					to_if_canceled: [tapped(0)],
				},
			},
		],
	};
}

/**
 * A running Odin toggles itself through its local server. Otherwise it's
 * started: the dev bundle is a bare Electron that shows its welcome screen
 * when opened on its own, so dev goes through the launcher applet.
 */
function toggleOdinCommand(): string {
	const home = process.env.ODIN_HOME_DIR ?? join(homedir(), ".odin");
	const bundle = app.isPackaged
		? resolve(process.execPath, "../../..")
		: "/Applications/Odin Dev.app";
	return `curl -sf -X POST "http://127.0.0.1:$(cat '${home}/notifications-port')/toggle" || open '${bundle}'`;
}

function selectedProfile(config: KarabinerConfig) {
	const profile = config.profiles.find((p) => p.selected) ?? config.profiles[0];
	if (!profile) throw new Error("Karabiner has no profile");
	return profile;
}

/** The key the installed rule listens to, or null when there's no rule. */
export function doubleTapKey(config: KarabinerConfig): DoubleTapKey | null {
	const rules = selectedProfile(config).complex_modifications?.rules ?? [];
	const key = rules.find((r) => IS_OURS.test(r.description ?? ""))
		?.manipulators?.[0]?.from?.key_code;
	return key && key in DOUBLE_TAP_KEYS ? (key as DoubleTapKey) : null;
}

/** Appended after the rules already there, so a Kid lock above it still wins. */
export function withDoubleTap(
	config: KarabinerConfig,
	key: DoubleTapKey | null,
	command: string,
): KarabinerConfig {
	const profile = selectedProfile(config);
	const others = (profile.complex_modifications?.rules ?? []).filter(
		(r) => !IS_OURS.test(r.description ?? ""),
	);
	profile.complex_modifications = {
		...profile.complex_modifications,
		rules: key ? [...others, doubleTapRule(key, command)] : others,
	};
	return config;
}

/** null when Karabiner isn't set up. A file that won't parse throws, so it's never overwritten. */
function readConfig(): KarabinerConfig | null {
	let raw: string;
	try {
		raw = readFileSync(CONFIG_PATH, "utf8");
	} catch {
		return null;
	}
	return JSON.parse(raw) as KarabinerConfig;
}

export const createKarabinerRouter = () => {
	return router({
		doubleTap: publicProcedure.query(() => {
			const config = readConfig();
			return {
				available: config !== null,
				key: config ? doubleTapKey(config) : null,
			};
		}),
		/** null turns it off. */
		setDoubleTap: publicProcedure
			.input(
				z.object({
					key: z
						.enum(Object.keys(DOUBLE_TAP_KEYS) as [DoubleTapKey])
						.nullable(),
				}),
			)
			.mutation(({ input }) => {
				const config = readConfig();
				if (!config) throw new Error("Karabiner-Elements isn't set up");
				withDoubleTap(config, input.key, toggleOdinCommand());
				// Write-then-rename, so Karabiner never reloads a half-written file.
				const tmp = `${CONFIG_PATH}.odin-tmp`;
				writeFileSync(tmp, `${JSON.stringify(config, null, 4)}\n`);
				renameSync(tmp, CONFIG_PATH);
			}),
	});
};
